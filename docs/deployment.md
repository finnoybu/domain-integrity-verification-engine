# Deployment

This document defines deployment expectations for Domain Integrity Engine.

## Scope

- Production deployment posture for reverse proxy + Node runtime
- Environment variable requirements
- Operational controls and validation

## Recommended Topology

1. Edge DNS and TLS policy via Cloudflare
2. Reverse proxy via Caddy
3. Next.js Node application process (`npm start`)
4. Monitor tick (`npm run monitor:tick`) scheduled via `cron` or a `systemd`
   timer on the same host
5. Persistent filesystem for snapshot retention (`data/snapshots`)

## Required Environment Variables

- `NODE_ENV=production`
- `ADMIN_BOOTSTRAP_EMAIL=<your-email>` — seeds the first admin user on first
  boot (see Authentication below).
- `DIVE_AUTH_FROM=<from-address>` — sender address for magic-link sign-in
  emails (uses the same `DIVE_SMTP_*` transport as alerting).
- `RATE_LIMIT_ENABLED=true` (recommended)

### Optional — authentication

- `DIVE_BASE_URL` — externally-visible base URL used to build sign-in links
  (e.g. `https://dive.example.com`). If unset, derived from the request's
  forwarded headers — set it explicitly when behind a reverse proxy whose
  internal origin differs from the public URL.
- `AUTH_TOKEN` — **legacy.** No longer gates the app. If set on first boot of
  v0.3.0 (with an empty `api_tokens` table), its value is adopted into the
  `api_tokens` table so existing `Authorization: Bearer` integrations keep
  working. Rotate it afterwards from the CLI and drop the env var.
- `DIVE_INSECURE_COOKIES=true` — disables the `Secure` cookie flag. Only for a
  rare plain-HTTP production deployment; leave unset when serving over TLS.
- `DIVE_AUTH_DEV_ECHO=true` — **local development only.** Prints the magic-link
  URL to the server console instead of requiring SMTP. Never set in production.

### Optional — monitor

- `OWNERSHIP_LOOKUP_TIMEOUT_MS` — TXT lookup timeout for the
  proof-of-control gate (default `5000`).
- `SNAPSHOT_RETENTION` — snapshots kept per domain on disk (default `30`,
  floor `2`).
- `DIVE_LICENSE` — license token, if any. Determines the active-domain
  capacity the tick iterates each pass.
- `MONITOR_INTERVAL` — read only by the dev-loop wrapper (`npm run
  monitor`); the production scheduler (cron / systemd timer) owns cadence.
  Default `3600`, floor `60`.

### Optional — alert email channel

Used only when an SMTP channel exists and is enabled in the dashboard's
Alerts page. Credentials are read from the environment, never the channel
config in the database.

- `DIVE_SMTP_HOST` — SMTP relay host (e.g. `email-smtp.us-east-1.amazonaws.com`).
- `DIVE_SMTP_PORT` — SMTP port (default `587`).
- `DIVE_SMTP_USER` — SMTP username, if authentication is required.
- `DIVE_SMTP_PASS` — SMTP password / token.
- `DIVE_SMTP_SECURE` — `true` to use TLS from connection start (port 465);
  otherwise STARTTLS on the configured port.

## Runtime Requirements

- Node.js 20+
- Writable storage path for runtime snapshot files
- Outbound network access for RDAP, DNS, and TLS remote checks

## Operational Controls

- Run behind reverse proxy; do not expose internal process directly
- Restrict inbound traffic to expected ports
- Rotate API tokens on a regular interval (`npm run token -- revoke <id>` then
  mint a fresh one); keep the `users` table limited to current operators
- Monitor API status and error rates
- Keep host and runtime patched

## Authentication

DIVE is multi-user, single-install. Operators sign in with a **magic link**
(no passwords); API clients authenticate with a **bearer token**.

**Sign-in (browser).** `ADMIN_BOOTSTRAP_EMAIL` seeds the first admin user on
first boot. That user visits `/login`, enters their email, and receives a
single-use sign-in link (15-minute TTL) sent via the `DIVE_SMTP_*` transport.
Consuming the link sets an HTTP-only, `SameSite=Lax`, `Secure` session cookie
(30-day sliding TTL). Inviting additional users from the UI is a post-v0.3.0
follow-up; until then the `users` table is seeded via `ADMIN_BOOTSTRAP_EMAIL`
or edited directly.

**API access (integrations, scripts).** Endpoints under `/api/*` accept either
a valid session cookie or `Authorization: Bearer <token>` matching an active
row in the `api_tokens` table. Manage tokens with the CLI:

```sh
npm run token -- mint "monitor-cron"   # prints the plaintext ONCE
npm run token -- list                  # metadata only, never the plaintext
npm run token -- revoke <id>
```

Tokens are stored hashed (SHA-256) and shown only at mint time. An existing
`AUTH_TOKEN` is adopted automatically on first boot (see env vars) so upgrades
don't break Bearer integrations.

**Local development.** Set `DIVE_AUTH_DEV_ECHO=true` to print sign-in links to
the server console instead of sending email — no SMTP server needed.

## Monitor

Unattended monitoring runs as a **single-tick** Node process invoked by an
external scheduler. Each tick walks the licensed-active domains and, per
[monitoring-design.md](monitoring-design.md) and
[ownership-verification-design.md](ownership-verification-design.md),
runs the ownership check as step 0, snapshots on pass, classifies, and
dispatches alerts on transitions. The process exits at the end of the pass —
no in-process state survives between ticks (state lives in the store).

```sh
npm run monitor:tick
```

Writes time-prefixed log lines to stdout (pipe to `journald` / your log
collector). Shares the app's filesystem store (`data/`), so the tick must
run on the same host as the Next.js process. Exit code `0` on completion
regardless of per-domain errors (those are logged); `1` on a fatal error.
Frozen (over-capacity) domains are skipped automatically.

### Scheduling

Pick whatever scheduler the host already runs. Two common patterns:

**cron** — one line, hourly tick:

```cron
0 * * * * cd /opt/dive && /usr/bin/npm run monitor:tick >> /var/log/dive/monitor.log 2>&1
```

**systemd timer** — better journald integration:

```ini
# /etc/systemd/system/dive-monitor.service
[Unit]
Description=DIVE monitor tick

[Service]
Type=oneshot
WorkingDirectory=/opt/dive
EnvironmentFile=/opt/dive/.env.production
ExecStart=/usr/bin/npm run monitor:tick

# /etc/systemd/system/dive-monitor.timer
[Unit]
Description=Run DIVE monitor tick hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now dive-monitor.timer`. Adjust `OnCalendar=`
(or the cron expression) to match the desired check cadence — DIVE's check
work has a floor of one minute per domain but is typically scheduled hourly.

### Dev-loop wrapper (not for production)

`npm run monitor` is a thin sleep-loop wrapper that calls `runOneTick`
repeatedly with a `MONITOR_INTERVAL`-second sleep between passes. It's
preserved for **local development convenience only** — terminal-watching
while iterating on monitor or alerting code. Don't use it for production:
the daemon shape doesn't compose with the per-domain interval overrides
the dashboard will surface, and a single tick scheduled by the OS is the
correct architecture (see docs/dashboard-design.md, Monitor architecture).

### Alerting

State transitions detected per tick (stability + ownership) fire alerts
through any **channel** that a matching **route** sends to. Both live in
SQLite (`alert_channels` / `alert_routes`) and are managed from the
dashboard — see **/alerts** for channel CRUD and default (all-domains)
routes, and the **Routing** section on a domain's detail page for
per-domain overrides.

- **Channels** are SMTP or webhook destinations. SMTP credentials come from
  `DIVE_SMTP_*` env vars; the channel itself holds only the routing-relevant
  config (from/to, or url/method/headers). A channel's `enabled` flag mutes
  it without deleting its routes.
- **Routes** map a scope (`all` or a single domain) to one channel, and list
  which severities (`info` / `warning` / `critical`) the route forwards.
- **Resolution is OVERRIDE:** if a domain has any per-domain routes, those
  fully replace the defaults for that one domain; otherwise the default
  routes apply. The monitor tick loads channels + routes once per pass, so
  dashboard edits take effect on the next scheduled tick — no restart.
- Severity is inferred from the new state: `critical` for risk / critical /
  invalid / ownership_failed; `warning` for drift; `info` for stable
  recoveries and verified-ownership confirmations.
- Dedup is persisted per-domain in the store (`lastAlerted`), so transitions
  alert exactly once and a fresh tick invocation does not re-fire alerts for
  the current state. The first observation of a domain initialises the
  record silently.

#### Upgrading from `alerts.local.json` (pre-v0.3.0)

On first boot under v0.3.0 with an existing `alerts.local.json` at the
process cwd, each configured channel is imported into `alert_channels` and
the global severities become a default route per channel — dispatch
behaviour is preserved. The original file is archived to
`alerts.local.json.imported`. The committed `alerts.sample.json` documents
the import-source format; configure all subsequent changes from the
dashboard.

### App process management (sketch)

The Next.js app runs as a long-lived service. A minimal systemd unit:

```ini
# /etc/systemd/system/dive-app.service
[Service]
WorkingDirectory=/opt/dive
EnvironmentFile=/opt/dive/.env.production
ExecStart=/usr/bin/npm start
Restart=on-failure
```

The monitor tick is a separate systemd timer — see Scheduling above.

## Verification

- `npm run lint`
- `npm run build`
- Confirm authenticated access to protected endpoints
- Confirm deterministic response behavior for `401`, `429`, and `5xx` paths

## Release Discipline

- Feature branch → pull request → squash merge to `main`
- Annotated version tag created on `main` only
- Tag pushed after merge and verification

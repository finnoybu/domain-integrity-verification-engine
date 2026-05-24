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
- `AUTH_ENABLED=true`
- `AUTH_TOKEN=<strong-random-token>`
- `RATE_LIMIT_ENABLED=true` (recommended)

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

Used only when the email channel is enabled in `alerts.local.json`. SMTP
credentials are read from the environment, never the config file.

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
- Rotate `AUTH_TOKEN` on a regular interval
- Monitor API status and error rates
- Keep host and runtime patched

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
through any channel enabled in `alerts.local.json`. The file is read once
per tick — config edits take effect on the next scheduled tick. Copy
`alerts.sample.json` to `alerts.local.json` (gitignored, like
`ruleset.local.json`) and edit:

```jsonc
{
  "channels": {
    "email":   { "enabled": false, "from": "dive@you.com", "to": ["ops@you.com"] },
    "webhook": { "enabled": false, "url": "https://hooks.slack.com/services/…" }
  },
  "severities": { "info": false, "warning": true, "critical": true }
}
```

- Both channels default to disabled — DIVE computes and logs alert events
  either way, but nothing dispatches until at least one is enabled.
- SMTP credentials for the email channel come from `DIVE_SMTP_*` env vars
  (see above); the config holds only the from/to lists, so a redacted
  config is safe to share.
- The webhook channel POSTs `{ "events": [...] }` to the configured URL,
  with a 10s timeout and any extra `headers` you set.
- Severity is inferred from the new state: `critical` for risk / critical /
  invalid / ownership_failed; `warning` for drift; `info` for stable
  recoveries and verified-ownership confirmations.
- Dedup is persisted per-domain in the store (`lastAlerted`), so transitions
  alert exactly once and a fresh tick invocation does not re-fire alerts for
  the current state. The first observation of a domain initialises the
  record silently.

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

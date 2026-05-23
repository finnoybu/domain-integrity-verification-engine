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
4. Monitor worker process (`npm run monitor`) running alongside the app
5. Persistent filesystem for snapshot retention (`data/snapshots`)

## Required Environment Variables

- `NODE_ENV=production`
- `AUTH_ENABLED=true`
- `AUTH_TOKEN=<strong-random-token>`
- `RATE_LIMIT_ENABLED=true` (recommended)

### Optional — monitor worker

- `MONITOR_INTERVAL` — seconds between monitor ticks (default `3600`,
  floor `60`).
- `OWNERSHIP_LOOKUP_TIMEOUT_MS` — TXT lookup timeout for the
  proof-of-control gate (default `5000`).
- `SNAPSHOT_RETENTION` — snapshots kept per domain on disk (default `30`,
  floor `2`).
- `DIVE_LICENSE` — license token, if any. Determines the active-domain
  capacity the worker iterates each tick.

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

## Monitor Worker

A separate Node process performs unattended monitoring per
[monitoring-design.md](monitoring-design.md): every `MONITOR_INTERVAL` seconds
it runs the ownership check (per
[ownership-verification-design.md](ownership-verification-design.md)) as step 0
for each active domain, then — on pass — takes a snapshot and runs the
stability classifier. Failures tick the three-strikes counter; the third
consecutive failed check flips state to `ownership_failed`.

```sh
npm run monitor
```

Runs in the foreground, writing time-prefixed log lines to stdout (pipe to
your log collector / `journald`). It shares the app's filesystem store
(`data/`), so it must run on the same host as the Next.js process. Graceful
shutdown: SIGINT / SIGTERM lets the current tick complete, then exits cleanly;
a second signal exits immediately. Frozen (over-capacity) domains are skipped
automatically.

### Alerting

State transitions detected by the worker (stability + ownership) fire alerts
through any channel enabled in `alerts.local.json`. The file is read once at
worker startup — restart the worker to reload it. Copy `alerts.sample.json`
to `alerts.local.json` (gitignored, like `ruleset.local.json`) and edit:

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
  alert exactly once and a worker restart does not re-fire alerts for the
  current state. The first observation of a domain initialises the record
  silently.

### Process management (sketch)

Run both processes under your supervisor of choice. A minimal systemd pair:

```ini
# dive-app.service — the Next.js app
[Service]
WorkingDirectory=/opt/dive
EnvironmentFile=/opt/dive/.env.production
ExecStart=/usr/bin/npm start
Restart=on-failure

# dive-monitor.service — the unattended monitor
[Service]
WorkingDirectory=/opt/dive
EnvironmentFile=/opt/dive/.env.production
ExecStart=/usr/bin/npm run monitor
Restart=on-failure
```

## Verification

- `npm run lint`
- `npm run build`
- Confirm authenticated access to protected endpoints
- Confirm deterministic response behavior for `401`, `429`, and `5xx` paths

## Release Discipline

- Feature branch → pull request → squash merge to `main`
- Annotated version tag created on `main` only
- Tag pushed after merge and verification

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
automatically. Phase D (alerting on transitions) is not in this build; the
worker logs state transitions today and a future PR adds email / webhook
dispatch on top.

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

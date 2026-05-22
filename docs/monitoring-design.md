# DIVE Monitoring — Design

**Status:** draft / design. No code yet. This document pins the architecture for
DIVE's continuous-monitoring capability before implementation. Open questions
are tracked at the end and are expected to change.

## Goal

Turn DIVE from an on-demand snapshot *tool* into a continuous *monitor*: it
should snapshot tracked domains on a schedule, detect when a domain's stability
classification changes or an expiry threshold is crossed, and alert — with no
one watching the dashboard. This is what makes a paid tier worth buying.

## Three capabilities

1. **Scheduled snapshots** — periodic and unattended.
2. **Alerting** — notify on classification transitions and expiry thresholds.
3. **Real retention** — keep enough snapshot history to be a governance record.

## Retention

`MAX_SNAPSHOTS_PER_DOMAIN` is currently `2` — only enough for a single diff. A
monitor, and an audit/governance product, need real history. Make it
configurable via an environment variable (e.g. `SNAPSHOT_RETENTION`, default
~30) — bounded, still deterministic. The retention enforcement
(`enforceSnapshotRetention`) already exists; only the limit changes. The diff
engine still compares the two newest snapshots — unchanged; the extra history
provides the timeline and the ability to prove past posture.

## Scheduler architecture

DIVE is a self-hosted Next.js app behind Caddy. Next.js has no native
background scheduling, and an in-process `setInterval` is unreliable (multiple
workers, no durability across restarts).

**Decision: a separate worker process.** A dedicated Node entrypoint (run via
`npm run monitor`) loops on a configurable interval (`MONITOR_INTERVAL`) and on
each tick: lists the active domains (frozen domains, beyond the licensed limit,
are skipped), snapshots each, runs classification, and dispatches alerts on
transitions. It shares DIVE's filesystem store and `src/lib` modules. Deployment
runs it alongside `npm start`; `docs/deployment.md` will document it.
Self-contained, no external cron dependency, deterministic — consistent with
DIVE's ethos.

**Prerequisite refactor.** Snapshot creation currently lives inside
`POST /api/snapshot` (`createSnapshot` in the route). It must move into a
reusable `src/lib` module so the worker and the API share one implementation.
A pure refactor, no behavior change — done before the worker.

**Open implementation detail.** The worker reuses TypeScript `src/lib` modules,
so running it as a standalone process needs a decision — a TypeScript runtime,
a small bundle step, or reusing the Next build output. Resolved in Phase C.

## Alerting

After each monitored snapshot is classified:

- **Transition detection** — compare the new `stability_state` against the
  previously recorded one for that domain. A change (stable → drift → risk →
  critical, or a recovery) is an alert event. Alert on the *transition*, not the
  steady state — a domain sitting in `risk` must not re-alert every tick.
- **Expiry thresholds** — TLS-certificate and domain-registration expiry
  crossing into risk/critical. The classification engine already emits these as
  signals; the monitor acts on them.
- **Channels** — start with **email** (AWS SES, already in the ecosystem stack)
  and a **generic webhook** (covers Slack, Teams, and custom endpoints).
- **Config** — an alert configuration (recipients / webhook URL, which
  severities trigger). File-based, in the spirit of `ruleset.local.json` — keeps
  it deterministic and reviewable.
- **State** — the monitor records the last-alerted classification per domain so
  transitions are computed deterministically and alerts are not duplicated.

## Phasing

- **Phase A — Retention.** Make `MAX_SNAPSHOTS_PER_DOMAIN` configurable and
  raise the default. Tiny and independent — ships first.
- **Phase B — Refactor.** Extract snapshot creation into `src/lib`. No behavior
  change; unblocks the worker.
- **Phase C — Scheduler.** The worker process: periodic snapshot + classify of
  the active domains, on an interval.
- **Phase D — Alerting.** Transition detection, de-duplication, email + webhook
  dispatch, and the alert configuration.

## Open questions

- Retention default — how many snapshots to keep per domain.
- Monitor interval default, and whether per-domain intervals are needed.
- Whether monitoring frequency is a licensed-tier differentiator (e.g. free =
  daily, paid = hourly) — this ties back to the licensing model.
- Alert config format (file vs environment) and granularity (global vs
  per-domain recipients and severities).
- The worker's TypeScript runtime approach (see Scheduler architecture).

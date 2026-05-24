# DIVE Dashboard — Design

**Status:** draft / design. No code yet. This document pins the architecture for
DIVE's v0.3.0 dashboard overhaul before implementation. Open questions are
tracked at the end and are expected to change during the PR arc.

## Goal

Turn DIVE's UI from a single-page dashboard wired ad-hoc as features landed
(`src/app/page.tsx`, ~1000 lines) into a real domain-monitoring console:
list/detail/settings information architecture, persisted alert configuration,
multi-user authentication, and a visual language that fits an
ops/security product. This unblocks the "configure per-domain monitoring and
alerting from the UI" path that the current monolith makes painful, and it
folds in two parked Phase D follow-ups (persistent per-domain alert config and
live reload) for free.

## Non-goals

- **Not** a hosted multi-tenant SaaS. Each DIVE install remains a single
  account/tenant; multi-user means multiple operators on one install
  (collaboration), not many isolated customers on shared infrastructure. The
  hosted SaaS direction stays a v0.4.0+ track.
- **Not** a re-platforming. Next.js + Tailwind 4 stay. The data layer evolves
  (see below) and the monitor shape changes (see Monitor architecture), but the
  runtime remains a self-hosted Node process. Hosting on Cloudflare or another
  serverless platform is a deliberately deferred conversation
  (see Hosting).
- **Not** an adoption of the Aegis Platform UI or the
  `@aegis-initiative/design-system`. DIVE is a standalone Finnoybu product;
  brand, audience, and stack all differ from AEGIS. Visual coherence with the
  broader Ken-ecosystem is achieved through shared *primitives*
  (see Visual lineage), not shared code.

## Hosting

This track stays **self-hosted Node** (the existing Caddy + `npm start` model
in `docs/deployment.md`). The hosted / managed-SaaS direction recorded in the
project brief is real but currently has no committed customer and no
infrastructure decided. Designing v0.3.0 for it would mean choosing a host
(Cloudflare Workers vs Fly.io vs Vercel vs AWS …) without requirements to
choose against — premature optimization. SQLite, the monitor refactor, and
the dashboard structure proposed here all port cleanly to any of those hosts
when the time comes; the SQL schema in particular is identical between
`better-sqlite3` and Cloudflare D1.

**Forcing function for revisiting:** the first commercial customer asking for
managed DIVE. At that point write `docs/hosting-decision.md` with concrete
requirements (multi-tenant model, latency budget, per-customer isolation,
cost) and pick a host on evidence. That work is v0.4.0 or later, not now.

One concrete dependency the hosting decision will hit: DIVE's snapshot
pipeline uses Node's `dns` and `tls` built-in modules. Cloudflare Workers'
support for those is partial — verifying the snapshot path runs on Workers
at all is a real prerequisite for that host, not an assumption. Fly.io,
Railway, and a VPS all run Node natively with no compatibility risk.

## Visual lineage

**Primitives layer:** `shadcn/ui` dropped onto the existing Tailwind 4 setup.
Components are copied into the DIVE repo (no upstream package dependency, no
version-drift risk), giving us Button / Table / Dialog / Form / Card / Toast /
Sheet primitives without inheriting AEGIS's design tokens. This is the
practical mid-point between "hand-roll every input" and "adopt a sibling
product's design system."

**Information-architecture reference:** **DNSimple's dashboard.** Closest
analog to where DIVE is going — domain-centric monitoring product, list-as-home
with per-domain drill-down, settings split by concern, left-nav structure.
The IA below largely mirrors theirs.

**Visual-restraint reference:** **Linear** and the **Stripe Dashboard**.
Monochromatic, lots of whitespace, data-dense without noise. The tone fits
DIVE's "deterministic, rule-driven, never probabilistic" positioning better
than a colorful consumer-style dashboard. Cloudflare's domain dashboard is
also a useful sanity check — many DIVE customers manage DNS there and will
arrive with that visual vocabulary.

## Information architecture

```
/                       redirects to /domains (if signed in) or /login
/login                  magic-link request form
/auth/verify?token=...  magic-link consumption endpoint
/domains                Domains list (home)
/domains/[domain]       Domain detail
/alerts                 Alert channels + routing
/license                License tier, capacity, paste-new-key
/settings               Global defaults
/account                Current user; sign out; (later) team management
```

**Domains list** — sortable/filterable table: domain, ownership state,
stability classification, last check, next check, drift signal summary.
Filter chips for state (verified / failed / unverified / frozen). Click-through
to detail. "Add Domain" button opens a dialog with the existing add/verify
flow.

**Domain detail** — per-domain page split into tabs or sections: Current
snapshot (the existing snapshot view), Signals & diff, History, Ownership,
Settings (per-domain interval override, per-domain alert routing override).
The current page.tsx's snapshot/diff/history rendering ports over largely
intact — only its packaging changes.

**Alerts** — replaces `alerts.local.json` with persisted config. Channels:
SMTP (already wired) and webhook (already wired) get configuration UI;
adding a channel writes to storage, no restart required. Routing: default
all-domains rules, plus per-domain overrides authored from the domain detail
page. This *is* the parked Phase D follow-up for per-domain alert config and
live reload — both close as a side effect.

**License** — current tier, capacity used (3/3 domains free tier, etc.),
paste-new-key flow (already partly built in the current page).

**Settings** — global defaults: `MONITOR_INTERVAL`, `SNAPSHOT_RETENTION`,
`OWNERSHIP_LOOKUP_TIMEOUT_MS`. Today these are env vars only; surfacing them
in the UI means writing to a config store and signaling the worker to reload
(see "Worker reload" below).

## Auth model

**Multi-user, single-install, magic-link only.** No passwords.

- **Magic link.** User enters email on `/login`; if the email is in the users
  table, DIVE issues a single-use token (15-minute TTL), emails it as a link
  via the existing `DIVE_SMTP_*` infrastructure (already configured for alerts),
  consumer endpoint sets a session cookie.
- **Why magic link:** no password hashing / reset / recovery flows to build;
  no DB-leak password-disclosure risk; better security baseline than
  email+password for a small ops-team product; leverages the SMTP setup that
  already exists. The trade-off is email-delivery dependency for sign-in —
  acceptable given the product is already SMTP-dependent for its primary
  alerting feature.
- **Sessions.** HTTP-only, secure, SameSite=Lax cookies. Server-side
  session table keyed by an opaque random token; 30-day TTL with sliding
  renewal.
- **First-run bootstrap.** First boot with an empty users table: an
  `ADMIN_BOOTSTRAP_EMAIL` env var seeds the first user; that user signs in
  via magic link and can invite further users from `/account`. Alternative:
  a one-time bootstrap token printed to the worker's stdout. The env-var
  approach is simpler and matches the "config via env" pattern already used
  for SMTP / license / retention.
- **API tokens.** A separate API-token table (per-user, named, revocable)
  preserves the current `Authorization: Bearer …` path for the monitor
  worker and any external integrations. The single-shared-token model goes
  away; existing installs are migrated by minting a token at upgrade time
  and surfacing it on first sign-in.

## Data model changes

The current file-based store (`data/*.json`) is not safe under concurrent
writes from the web app + the monitor worker; it works today because writes
are infrequent. The dashboard expansion makes this materially worse: alert
config edits, per-domain settings, login activity, session writes — all
multi-actor.

**Recommendation: introduce SQLite via `better-sqlite3`.** Embedded, file on
disk (`data/dive.db`), ACID, zero external services, no operational
dependency added. The "no external database" property the product memory
records stays true — SQLite is a file, not a service. The existing
`data/snapshots/<domain>/<ts>.json` snapshot files stay as-is (large
JSON blobs, append-mostly); only the index/state moves to SQLite.

**New tables:**

- `users(id, email, created_at, last_signed_in_at, is_admin)`
- `sessions(token, user_id, created_at, expires_at, last_used_at)`
- `magic_links(token, email, expires_at, consumed_at)`
- `api_tokens(token_hash, user_id, name, created_at, last_used_at, revoked_at)`
- `alert_channels(id, type, config_json, created_at)` — SMTP / webhook
  channels with their own config blobs
- `alert_routes(id, scope_type, scope_value, channel_id, severities_json)` —
  default rules + per-domain overrides
- `settings(key, value, updated_at)` — global config (interval, retention,
  lookup timeout) overrideable from the UI

**Migrated from JSON:**

- `domains(name, registered_at, ownership_state, ownership_token, …)`
- `ownership_checks(domain, checked_at, result, consecutive_failures)`
- `domain_settings(domain, key, value)` — per-domain overrides

**Unchanged:** snapshot blob files on disk; the BSL license file
(`license.local`); the gitignored signing key.

A migration script reads existing `data/domains.json` etc. on first run with
the new build, writes to SQLite, then archives the JSON to
`data/legacy-store/`.

## Monitor architecture

The current monitor (`src/monitor/index.ts`, shipped in PR #33) is a
long-running Node process that loops on `setInterval`, sleeps between ticks,
and holds in-process state. That was the cheapest thing to ship in Phase C —
it worked, the project moved on — but it's the wrong shape for what DIVE
actually does. Per-domain check work is bounded (TXT lookup, RDAP, DNS, TLS;
~30 seconds in the worst case); the interval is measured in hours; cross-tick
in-process state is no longer needed (Phase D persisted the dedup state to
the store). 99.9% of the worker's CPU today is sleeping.

**Decision: the monitor becomes a stateless single-tick entrypoint** —
`src/monitor/tick.ts` exporting and executing a `runOneTick()` that lists due
domains, runs the ownership-check → snapshot → classify → alert pipeline for
each, and exits. The new `npm run monitor:tick` runs it once.

**Scheduling moves to the OS / platform:**

- **Production (Linux):** system `cron` (e.g., `0 * * * * cd /opt/dive && npm run monitor:tick`) or a systemd timer. Documented in `docs/deployment.md`.
- **Local dev convenience:** `npm run monitor` is preserved as a thin
  sleep-loop wrapper around `runOneTick()` for terminal-watching during
  development. No production reliance on it.
- **Future host migration:** the same single-tick function is what a
  Cloudflare Cron Trigger, an EventBridge → Lambda, or a Fly.io scheduled
  machine invokes. The scheduling primitive binds at deploy time; the code
  is host-agnostic.

**Composition benefits beyond hosting:**

- Per-domain interval overrides (PR 6 of the dashboard track) compose
  cleanly: the tick reads `domain.next_check_at` from the store and runs
  only domains whose timestamp is past-due. A daemon-loop would need
  per-domain timers.
- Crash recovery is free — there's no in-process state to lose between
  ticks; the next scheduled invocation just runs.
- Operability matches the rest of the deployment surface — operators
  already know cron / systemd.

**Sequencing:** this refactor ships as **PR 0** of the v0.3.0 track, before
any dashboard or storage work, because (a) it's independent and revertable
on its own and (b) the dashboard's per-domain interval feature is much
cleaner against the single-tick model than against the daemon.

## Worker reload

Today the monitor worker reads env vars at startup and `alerts.local.json` on
each tick. With config moving into SQLite, the worker reads from SQLite on
each tick — the dashboard writes config, the worker picks it up on the next
loop iteration, no restart. This closes the parked Phase D follow-up
("live alerts.local.json reload") more cleanly than file-watching would.

Per-domain interval overrides need the worker to compute per-domain "next
check at" timestamps instead of a single global tick. Mechanically small —
the loop already iterates per-domain — but worth one paragraph in the
implementation PR.

## Backwards compatibility

- **Existing `Authorization: Bearer` API calls** continue to work after the
  bearer token is issued via the new `api_tokens` table at first sign-in.
  The monitor worker reads from an `API_TOKEN_FILE` (or env) the same way
  it does today.
- **Existing `data/domains.json`** is auto-migrated and archived.
- **Existing `alerts.local.json`** is auto-imported into the new alert
  tables and archived.
- **Existing env vars** (`MONITOR_INTERVAL`, `SNAPSHOT_RETENTION`, etc.)
  remain valid as defaults; UI-written values in `settings` take precedence
  when present.

## PR sequence

The track sizes at 7 PRs. Each lands behind `main`'s protections (squash +
admin merge); the design intent is for any PR to be independently revertable.

0. **Monitor rearchitecture — daemon to scheduled invocation.** Extracts
   `runOneTick()` into `src/monitor/tick.ts`, adds `npm run monitor:tick`,
   preserves `npm run monitor` as a thin sleep-loop wrapper for local dev,
   updates `docs/deployment.md` with cron and systemd-timer examples.
   No storage or UI changes. Independent of the dashboard track but
   prerequisite to PR 6's per-domain interval overrides.
1. **shadcn primitives + Tailwind tokens.** No app changes; just installs the
   shadcn CLI, copies the primitive set into `src/components/ui/`, sets the
   token palette (neutral default, see Decisions). Sanity-test by porting
   the verification panel's Verify and Copy token buttons.
2. **SQLite migration of the existing JSON store.** Pure data-layer change.
   `src/lib/storage.ts` becomes a SQLite-backed implementation; the old
   JSON-store code archives. Migration script runs at boot; existing installs
   transparently upgrade. **Must ship before any auth work** — sessions need
   ACID writes.
3. **Auth — magic-link sign-in, sessions, first-run bootstrap.** New tables,
   `/login`, `/auth/verify`, session middleware. Existing API routes gain a
   session check (with the bearer-token path preserved). `ADMIN_BOOTSTRAP_EMAIL`
   seeds the first user.
4. **App-router restructure — Domains list, Domain detail, License page.**
   `src/app/page.tsx` retires (or shrinks to a redirect). Existing functionality
   is preserved; the change is structural.
5. **Alerts page + persisted alert config.** Database-backed alert channels and
   routes; alerts.local.json import on first run, then archived. Worker reads
   from SQLite each tick. Per-domain alert routing UI on the Domain detail
   Settings tab.
6. **Settings page + per-domain interval overrides.** Global defaults
   editable in the UI; per-domain interval overrides surfaced on Domain
   detail. The tick computes per-domain next-check timestamps and processes
   only past-due domains.

After PR 6: cut v0.3.0.

## Decisions

Resolved at design time so implementation PRs don't restart these:

- **shadcn theme: neutral default.** Use shadcn's neutral palette. The
  existing severity colors (stable / drift / risk / critical) are kept as
  semantic accent colors for stability-state indicators only — they don't
  bleed into the general chrome. Avoids a bespoke palette that adds
  maintenance with no buyer-visible benefit.
- **First-user bootstrap: `ADMIN_BOOTSTRAP_EMAIL` env var.** Matches the
  existing operator-config pattern (SMTP, license, retention all set via
  env). On first boot with an empty users table, the email is seeded as an
  admin user who can then magic-link sign in. The other two options
  (printed token, first-visitor-becomes-admin) introduce more moving
  parts without a security improvement.
- **Magic-link rate limiting: 3 per email per 15 minutes.** Layered on top
  of the existing `enforceRateLimit` helper's general IP limit. Sane
  default; configurable later if needed.
- **Multi-user invitation flow: deferred.** Ship PR 3 with the single
  bootstrap admin; add a `POST /api/users` invite endpoint and `/account`
  UI in a follow-up after v0.3.0 ships. The architecture supports it
  (users table is already multi-row); the UI is the missing piece.

## Open questions

- **Per-domain settings UI granularity.** What's worth surfacing per-domain
  beyond interval and alert routing — lookup timeout? retention? Decide
  during PR 6.
- **Snapshot blob storage long-term.** SQLite is wrong for large JSON blobs;
  keeping them on disk is right. Whether to ever move them into S3-compatible
  object storage is a separate, later question (tied to the hosted SaaS
  direction).
- **Hosted-SaaS posture.** Multi-tenancy is explicitly out of scope here.
  When/if DIVE goes hosted, the auth model already supports it (sessions,
  magic links, per-user data), but the schema changes (tenant scoping
  everywhere) are real work and should get their own design doc — see
  Hosting.

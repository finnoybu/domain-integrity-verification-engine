# DIVE Domain Ownership Verification — Design

**Status:** draft / design. No code yet. This document pins how DIVE proves and
re-checks control of a monitored domain. Open questions are tracked at the end.

## Concept

Control of a monitored domain is proven by a DNS TXT record and **re-checked on
every monitoring cycle**. It is not a one-time onboarding step — it is a
continuous attestation and the **first gate of every check**. If the record is
missing or altered, that is itself a monitoring failure: it is reported and
alerted, and **no other checks run for that domain that cycle**.

Rationale: for a domain *integrity* engine, continuous proof-of-control is
itself an integrity signal. A verification record that has vanished or changed
means the operator no longer controls the domain's DNS — domain hijack, DNS
compromise, a lapsed registration taken over, or a deliberate removal. All of
those are exactly what DIVE should catch, immediately and above everything else.

The gate is **unconditional** — it applies to self-hosted, single-tenant
deployments as much as to the multi-tenant SaaS. Without it, DIVE could be
pointed at infrastructure the operator does not control and used to surveil a
third party's IP; requiring continuous proof of control keeps DIVE strictly a
tool for governing one's own domains.

## The verification record

- On adding a domain, DIVE issues a long, random per-domain token.
- The operator publishes a TXT record at `_dive-challenge.<domain>` containing
  the token. A dedicated subdomain keeps it isolated from SPF and other apex
  TXT records.
- The token is stored with the domain.

## The ownership check

Every check — every scheduled monitor tick **and** every on-demand snapshot —
begins with the ownership check:

1. Resolve TXT `_dive-challenge.<domain>`.
2. **Pass** — a record exists and exactly matches the issued token.
3. **Fail** — the record is absent, its value differs from the token, or the
   lookup cannot complete.

On pass → the consecutive-failure counter resets and the snapshot / diff /
classification pipeline proceeds. On fail → **stop**: no RDAP, DNS, TLS, or
classification is performed for that domain this cycle, and the
consecutive-failure counter increments.

**Three strikes.** A single failed check is not proof the record is gone —
resolvers time out and networks blip. `ownership_failed` is declared on the
**third consecutive failed check**; any passing check resets the counter to
zero. This absorbs transient DNS hiccups without false alarms, while still
catching a genuinely removed or altered record within three cycles.

## Ownership is a first-class state

DIVE's status model gains an ownership dimension that supersedes the rest. A
domain resolves to one of:

- `ownership_unverified` — never verified (just added; token not yet found).
- `ownership_verified` — proceed to stability classification as today.
- `ownership_failed` — three consecutive checks have failed; the record is
  missing, altered, or unreachable.

`ownership_unverified` and `ownership_failed` short-circuit — no `domain_state`
or `stability_state` is computed. `ownership_failed` is the highest-severity
event DIVE emits, above `critical`: loss of control of the domain subsumes any
drift finding. Between a first failed check and the third, the domain holds its
`ownership_verified` state, but each failing cycle still pauses its snapshot
pipeline.

## Notification

An ownership failure is an alert event in its own right (dispatched through the
monitor's alerting — see `docs/monitoring-design.md`, Phase D). It fires on the
*transition* into `ownership_failed`, not every tick while the domain stays
failed. Recovery — the record restored — is also a transition worth notifying.

## Data model

Each domain entry gains: the verification token, the ownership state, the time
ownership was last verified, the time it last failed, and a
consecutive-failure counter. Extends the filesystem store.

## Flow

- Add domain → token issued → `ownership_unverified`; DIVE shows the TXT record
  to publish.
- Operator publishes the record → verification check → `ownership_verified` →
  monitoring proceeds.
- Every subsequent check re-validates first. A later failure → `ownership_failed`
  + notification; the domain stays listed, but no further checks run until
  ownership is restored.

## Relationship to the monitor (#4)

This is **step 0 of the monitor's per-domain loop**: ownership-check → gate →
snapshot → classify → alert. The monitor scheduler (`docs/monitoring-design.md`,
Phase C) is built around it; ownership verification is therefore part of #4, not
a later track. The on-demand snapshot path (`POST /api/snapshot`) carries the
same gate.

## Phasing

- **Phase 1** — data model, the ownership-check function, add-time token
  issuance and initial verification (API + UI).
- **Phase 2** — wire the gate into the on-demand snapshot path.
- **Phase 3** — wire it as step 0 of the monitor scheduler; ownership-failure
  and recovery notifications.

## Open questions

- The per-check TXT-lookup timeout (the consecutive-failure threshold is fixed
  at three).
- Token rotation / re-issue, and whether a verified domain is ever re-tokenized.
- Relationship to the existing `domain_state: invalid` — a fully dead domain
  also fails the TXT lookup; which state takes precedence and how they are
  surfaced.
- Whether `ownership_failed` is a distinct alert channel/severity or folds into
  the existing severity ladder above `critical`.

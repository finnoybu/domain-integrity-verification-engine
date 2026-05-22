# DIVE Licensing — Design

**Status:** draft / design. No code yet. This document pins the licensing
architecture so the pieces fit on the first build. Open questions are tracked
at the end and are expected to change.

## Goals and constraints

- **Zero-touch operation.** Purchase, license delivery, renewal, and expiry all
  happen with no human in the loop. No step may depend on an operator response.
- **Offline verification.** A DIVE instance verifies its license locally, with
  no call back to a licensing server. Self-hosted deployments must work without
  any outbound dependency on Finnoybu infrastructure.
- **Deterrence, not DRM.** DIVE is source-available (BSL 1.1). A determined
  operator can read and patch out any license check. Enforcement exists to keep
  honest users compliant and make the paid path the path of least resistance —
  it is not, and cannot be, tamper-proof. No obfuscation, no anti-tamper
  theatre.
- **Minimal dependencies.** Signing and verification use Node's built-in
  `crypto` (Ed25519). No new runtime dependency in DIVE.

## Licensing model

| Tier | Domains | Use | Cost |
|---|---|---|---|
| Free | up to 3 | personal use, or an organization's internal operations | none |
| Licensed | per tier (e.g. 25 / 100 / 500 — placeholder) | same as Free, higher capacity | annual fee, 50% renewal |
| Commercial / SaaS | negotiated | offering DIVE as a service to third parties | separate commercial license |

The Free tier corresponds to the BSL 1.1 Additional Use Grant. **Related
change:** the Additional Use Grant in `LICENSE` currently grants internal
production use without a numeric limit; it should be updated to state the
3-domain cap. See Open questions.

## License token

A license is a single signed string the customer pastes into their DIVE
configuration.

**Format:** `<base64url(payload)>.<base64url(signature)>`

**Payload (JSON):**

```json
{
  "v": 1,
  "licenseId": "lic_...",
  "customer": "<email or customer id>",
  "tier": "standard-25",
  "domainLimit": 25,
  "issued": "2026-05-22",
  "expires": "2027-05-22"
}
```

**Signature:** Ed25519 over the canonical payload bytes, using the DIVE
licensing private key.

- The **public key** is embedded in DIVE's source (committed — a public key is
  not a secret).
- The **private key** signs tokens and never enters the repo. See Key
  management.

## DIVE-side: loading, verification, enforcement

**Loading.** DIVE reads the license from the `DIVE_LICENSE` environment
variable, consistent with existing config (`AUTH_TOKEN`, `AUTH_ENABLED`).
Absent → Free tier.

**Verification** (on startup, cached):

1. Split the token; base64url-decode the payload and signature.
2. Verify the Ed25519 signature against the embedded public key. Invalid →
   treat as unlicensed (Free tier), log a warning.
3. Compare `expires` against the current UTC date (see Clock handling).
   Expired → Free tier, surface an "expired" state.
4. Valid and current → effective `domainLimit` = `payload.domainLimit`.

**Enforcement.** The add-domain path checks
`activeDomainCount < effectiveDomainLimit` (Free limit = 3). Over the limit →
the add is rejected with a clear message. The scheduler (monitor features)
snapshots only active domains.

**Clock handling.** Expiry is checked against the system clock, which a
self-hosted operator controls. Mitigation: DIVE persists a high-water-mark
timestamp in its data directory — the latest time it has ever observed. If
`now < highWaterMark`, the clock has moved backward and expiry is evaluated
against `highWaterMark`. This deters casual clock-rollback; it is not
unbreakable, consistent with the deterrence-not-DRM stance.

## Graceful downgrade

On expiry, or an invalid/removed license, DIVE **does not delete data.** It
downgrades:

- 3 domains remain **active** (snapshotted, monitored), chosen by a
  deterministic rule (see Open questions).
- Domains beyond 3 become **frozen**: still visible, last snapshot still shown,
  but not snapshotted or monitored, and flagged "license required."
- No new domains can be added beyond the active count.
- Restoring a valid license immediately reactivates all domains within its
  limit.

## Issuance pipeline (storefront)

```text
Customer -> Stripe Checkout / Payment Link -> payment
  -> Stripe webhook (invoice.paid)
       -> verify Stripe signature
       -> determine tier from the purchased price
       -> mint signed token (1-year expiry)
       -> record the license (licenseId, customer, tier, expiry)
       -> email the token to the customer (AWS SES)
```

- **Checkout** is Stripe-hosted (Payment Link or Checkout Session) — no custom
  payment UI.
- **Subscriptions** make renewal automatic: Stripe charges annually, retries
  failed payments (dunning), and sends receipts. The **50% renewal** is
  modelled as a subscription at the renewal rate plus a one-time first-year
  add-on (net: year 1 full, year 2+ half); exact Stripe modelling is an
  implementation detail.
- Each successful payment — initial **and** every renewal — fires the same
  webhook, producing a fresh token with a new expiry, emailed automatically.
- **Customer-side renewal:** the customer drops the new token into their
  `DIVE_LICENSE` config — a once-a-year action, theirs not ours. An optional
  future license-refresh endpoint DIVE could poll is deliberately deferred: it
  reintroduces a phone-home dependency.
- **Hosting:** the webhook is a small serverless function, separate from DIVE
  itself. Cloudflare Worker + D1 for the license record matches the existing
  Finnoybu Press stack.

## Minting CLI

A small Node script (`scripts/mint-license.mjs`) signs a token given `--tier`,
`--domains`, `--customer`, and `--expires`. It is both:

- the signing core the issuance webhook reuses, and
- the **interim issuance tool** — until the storefront exists, a license
  (free, dev, or trial) can be minted by hand. This is what makes handing
  someone a key possible before Phase 2.

The CLI loads the private key from a local key file or environment variable,
never the repo.

## Key management

- One Ed25519 keypair for the project.
- Public key: committed in DIVE's source.
- Private key: generated once, stored as a secret — a local key file for the
  CLI, a Cloudflare secret for the webhook — and backed up securely.
- Key rotation is disruptive (tokens signed by an old key stop verifying).
  Treat the private key as long-lived; a rotation strategy is deferred.

## Build phases

**Phase 1 — foundation (build now).** In DIVE: the token-verification module,
the embedded public key, the `DIVE_LICENSE` read, the Free-tier (3-domain) cap
and enforcement, graceful downgrade. Plus the `mint-license` CLI. Outcome: a
working Free/Licensed split, and a tool to mint keys by hand.

**Phase 2 — automated issuance.** Stripe products/prices, the issuance webhook,
SES email, the license record store. Outcome: hands-off purchase → delivery →
renewal.

**Phase 3 — storefront polish (later, optional).** A customer-facing site:
accounts, license dashboard, in-app tier changes. Convenience, not a
requirement for zero-touch operation.

The **monitor features** (scheduler, alerting, retention) are a separate track.
Licensing assumes they exist for a paid tier to be *worth* buying, but the
licensing mechanism does not depend on them — Phase 1 can land independently.

## Open questions

- Pricing, and the domain count per tier (25 / 100 / 500 are placeholders).
- Update the BSL Additional Use Grant in `LICENSE` to state the 3-domain Free cap.
- Downgrade: which 3 domains stay active — earliest-added (deterministic
  default) vs. letting the user choose.
- The free-public-host edge in the Additional Use Grant, unresolved from the
  relicensing discussion.
- Whether to ever add an optional online license-refresh endpoint.
- Key-rotation strategy.

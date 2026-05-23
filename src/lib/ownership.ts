import { promises as dns } from "dns";
import {
  createOwnershipRecord,
  getOwnership,
  ownershipVerificationRecord,
  setOwnership,
  type OwnershipRecord,
} from "./storage";

// ============================================================================
// Ownership verification — the continuous proof-of-control gate.
//
// Per docs/ownership-verification-design.md, every snapshot / monitor cycle
// begins with a TXT lookup at `_dive-challenge.<domain>` and compares the
// value against the per-domain token stored with the domain. This module is
// the lookup primitive (verifyOwnership) plus a check-and-record helper that
// applies the three-strikes counter rule.
//
// recordOwnershipCheck is used by the gated paths (PR 2: /api/snapshot
// default action; PR 3: the monitor worker). The user-initiated setup verify
// in PR 1 uses verifyOwnership directly and applies its own state transition
// without touching the counter — the strike rule is meant for unattended
// checks, not the operator clicking "Verify" while still publishing the TXT.
// ============================================================================

/** Threshold of consecutive failed checks that flips state to ownership_failed. */
export const OWNERSHIP_FAILURE_THRESHOLD = 3;

/** TXT lookup timeout in milliseconds. Override with OWNERSHIP_LOOKUP_TIMEOUT_MS. */
function resolveLookupTimeoutMs(): number {
  const configured = Number(process.env.OWNERSHIP_LOOKUP_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return 5000;
}

export type OwnershipVerifyFailReason =
  | "lookup_failed"
  | "token_mismatch";

export type OwnershipVerifyResult =
  | { pass: true; foundRecords: string[] }
  | { pass: false; reason: OwnershipVerifyFailReason; foundRecords: string[]; detail?: string };

/**
 * Resolves `_dive-challenge.<domain>` and returns whether any TXT record's
 * value matches `expectedToken`. Network failures, timeouts, and missing
 * records all surface as `pass: false` with `reason: "lookup_failed"`.
 */
export async function verifyOwnership(
  domain: string,
  expectedToken: string,
): Promise<OwnershipVerifyResult> {
  const record = ownershipVerificationRecord(domain);
  const timeoutMs = resolveLookupTimeoutMs();

  let txtRecords: string[][];
  try {
    txtRecords = await Promise.race<string[][]>([
      dns.resolveTxt(record),
      new Promise<string[][]>((_, reject) =>
        setTimeout(() => reject(new Error("TXT lookup timed out")), timeoutMs),
      ),
    ]);
  } catch (error) {
    return {
      pass: false,
      reason: "lookup_failed",
      foundRecords: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // DNS TXT records are arrays of string chunks; join each chunk array.
  const joined = txtRecords.map((chunks) => chunks.join(""));
  const match = joined.find((value) => value === expectedToken);
  if (match !== undefined) {
    return { pass: true, foundRecords: joined };
  }
  return {
    pass: false,
    reason: "token_mismatch",
    foundRecords: joined,
  };
}

/**
 * Runs the ownership check for a domain and updates its stored state per the
 * three-strikes rule: a pass resets the counter and refreshes
 * `ownership_verified`; a fail increments the counter, and the third
 * consecutive failure flips state to `ownership_failed`. Between strikes, an
 * already-verified domain holds its `ownership_verified` state — the snapshot
 * pipeline is gated on the per-check pass/fail, not the persisted state.
 *
 * Returns the verify result together with the updated record so callers can
 * decide whether to proceed (snapshot) or surface an alert / error.
 */
export async function recordOwnershipCheck(
  domain: string,
): Promise<{ result: OwnershipVerifyResult; ownership: OwnershipRecord }> {
  let ownership = await getOwnership(domain);
  if (!ownership) {
    // Defensive: caller should have registered first. Mint a record so the
    // check has a token to compare against — it will fail (the TXT can't
    // exist yet), which is the correct signal.
    ownership = createOwnershipRecord();
  }

  const now = new Date().toISOString();
  const result = await verifyOwnership(domain, ownership.token);

  if (result.pass) {
    ownership = {
      ...ownership,
      state: "ownership_verified",
      verifiedAt: now,
      consecutiveFailures: 0,
    };
  } else {
    const consecutiveFailures = ownership.consecutiveFailures + 1;
    const state =
      consecutiveFailures >= OWNERSHIP_FAILURE_THRESHOLD
        ? "ownership_failed"
        : ownership.state;
    ownership = {
      ...ownership,
      state,
      failedAt: now,
      consecutiveFailures,
    };
  }

  await setOwnership(domain, ownership);
  return { result, ownership };
}

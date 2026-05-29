import { NextRequest, NextResponse } from "next/server";
import {
  canSnapshotDomain,
  getOwnership,
  isValidDomain,
  ownershipVerificationRecord,
  persistSnapshot,
  registerDomain,
  setOwnership,
} from "@/lib/storage";
import { createSnapshot } from "@/lib/snapshot";
import { recordOwnershipCheck, verifyOwnership } from "@/lib/ownership";
import {
  badRequest,
  enforceRateLimit,
  errorResponse,
  getRequestId,
  internalError,
  licenseLimitReached,
  logServerError,
  notFound,
  ownershipFailed,
} from "@/lib/api-helpers";
import { requireAuth } from "@/lib/auth-server";

export async function POST(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) {
    return rateLimited;
  }

  const auth = requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const { domain, action } = await request.json();

    if (!domain) {
      return badRequest("Domain is required", requestId);
    }

    const normalizedDomain = domain.toLowerCase().trim();

    if (action === "delete") {
      const { deleteDomain } = await import("@/lib/storage");
      const success = await deleteDomain(normalizedDomain);

      if (!success) {
        return notFound("Domain not found", requestId);
      }

      return NextResponse.json({ success: true, message: "Domain deleted" });
    }

    if (action === "add") {
      // Register the domain without snapshotting. Issues an ownership token;
      // the user publishes it at _dive-challenge.<domain> and then verifies.
      const access = await canSnapshotDomain(normalizedDomain);
      if (!access.allowed) {
        return licenseLimitReached(access.reason, requestId);
      }

      const ownership = await registerDomain(normalizedDomain);
      return NextResponse.json(
        {
          domain: normalizedDomain,
          ownership,
          verificationRecord: ownershipVerificationRecord(normalizedDomain),
        },
        { status: 201 },
      );
    }

    if (action === "verify") {
      // User-initiated setup verification: TXT lookup against the stored
      // token. On pass — mark verified and take the first snapshot inline.
      // On fail — surface the lookup detail without touching the strike
      // counter (that's reserved for unattended monitor checks).
      const ownership = await getOwnership(normalizedDomain);
      if (!ownership) {
        return notFound("Domain not registered", requestId);
      }

      const result = await verifyOwnership(normalizedDomain, ownership.token);

      if (!result.pass) {
        const detail =
          result.reason === "token_mismatch"
            ? `TXT records at ${ownershipVerificationRecord(normalizedDomain)} do not match the issued token. Found: ${result.foundRecords.length === 0 ? "(none)" : result.foundRecords.join(", ")}.`
            : `TXT lookup for ${ownershipVerificationRecord(normalizedDomain)} did not complete. ${result.detail ?? ""}`.trim();
        return errorResponse("invalid_input", detail, 400, { requestId });
      }

      const now = new Date().toISOString();
      const verifiedOwnership = {
        ...ownership,
        state: "ownership_verified" as const,
        verifiedAt: now,
        consecutiveFailures: 0,
      };
      await setOwnership(normalizedDomain, verifiedOwnership);

      // First snapshot inline — the operator sees data immediately on verify.
      const valid = await isValidDomain(normalizedDomain);
      const snapshot = await createSnapshot(normalizedDomain);
      if (valid) {
        await persistSnapshot(normalizedDomain, snapshot);
      }

      return NextResponse.json({
        domain: normalizedDomain,
        ownership: verifiedOwnership,
        snapshot,
      });
    }

    // Default action: re-snapshot an already-registered domain. License
    // check first, then the unconditional ownership gate — no RDAP / DNS /
    // TLS work runs until the per-cycle TXT proof-of-control passes.
    const access = await canSnapshotDomain(normalizedDomain);
    if (!access.allowed) {
      return licenseLimitReached(access.reason, requestId);
    }

    const existingOwnership = await getOwnership(normalizedDomain);
    if (!existingOwnership) {
      // Pre-ownership API contract auto-created on first snapshot; the new
      // contract requires explicit registration so the operator sees the
      // TXT challenge before any check runs.
      return notFound(
        `Domain ${normalizedDomain} is not registered. Add it first with action: "add", publish the TXT challenge at ${ownershipVerificationRecord(normalizedDomain)}, then verify.`,
        requestId,
      );
    }

    // Ownership gate — applies the three-strikes counter rule. On pass, the
    // record is refreshed to ownership_verified; on fail, the counter ticks
    // and the third consecutive failure flips state to ownership_failed.
    const ownershipCheck = await recordOwnershipCheck(normalizedDomain);
    if (!ownershipCheck.result.pass) {
      const found = ownershipCheck.result.foundRecords;
      const detail =
        ownershipCheck.result.reason === "token_mismatch"
          ? `TXT records at ${ownershipVerificationRecord(normalizedDomain)} do not match the issued token. Found: ${found.length === 0 ? "(none)" : found.join(", ")}.`
          : `TXT lookup for ${ownershipVerificationRecord(normalizedDomain)} did not complete.`;
      const stateNote =
        ownershipCheck.ownership.state === "ownership_failed"
          ? ` Ownership state is now ownership_failed after ${ownershipCheck.ownership.consecutiveFailures} consecutive failed checks.`
          : ` ${ownershipCheck.ownership.consecutiveFailures} of 3 consecutive failures.`;
      return ownershipFailed(`${detail}${stateNote}`, requestId);
    }

    // Check whether the domain is valid
    const valid = await isValidDomain(normalizedDomain);

    const snapshot = await createSnapshot(normalizedDomain);

    // Only persist if domain is valid
    if (valid) {
      await persistSnapshot(normalizedDomain, snapshot);
    }

    return NextResponse.json(snapshot, { status: 201 });
  } catch (error) {
    logServerError(requestId, "Snapshot API error", error);
    return internalError("Failed to create snapshot", requestId);
  }
}

export async function GET(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) {
    return rateLimited;
  }

  const auth = requireAuth(request);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const { getDomainSnapshot, getDomainAccess } = await import("@/lib/storage");
    const access = await getDomainAccess();
    const allDomains = [...access.active, ...access.frozen];

    const domainsList = await Promise.all(
      allDomains.map(async (domain) => {
        const snapshot = await getDomainSnapshot(domain);
        const ownership = await getOwnership(domain);
        return {
          domain,
          snapshot,
          ownership,
          verificationRecord: ownershipVerificationRecord(domain),
          active: access.active.includes(domain),
        };
      })
    );

    return NextResponse.json({
      domains: domainsList,
      license: {
        licensed: access.license.licensed,
        tier: access.license.tier,
        domainLimit: access.limit,
        expires: access.license.expires,
        expired: access.license.expired,
        reason: access.license.reason,
      },
    });
  } catch (error) {
    logServerError(requestId, "GET snapshot error", error);
    return internalError("Failed to fetch domains", requestId);
  }
}

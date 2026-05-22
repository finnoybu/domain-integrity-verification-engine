import { NextRequest, NextResponse } from "next/server";
import { persistSnapshot, isValidDomain, canSnapshotDomain } from "@/lib/storage";
import { createSnapshot } from "@/lib/snapshot";
import {
  badRequest,
  enforceRateLimit,
  getRequestId,
  internalError,
  licenseLimitReached,
  logServerError,
  notFound,
} from "@/lib/api-helpers";

export async function POST(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) {
    return rateLimited;
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

    // Default action: create/update snapshot and persist to disk.
    // Enforce the licensed domain capacity before any network work.
    const access = await canSnapshotDomain(normalizedDomain);
    if (!access.allowed) {
      return licenseLimitReached(access.reason, requestId);
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

  try {
    const { getDomainSnapshot, getDomainAccess } = await import("@/lib/storage");
    const access = await getDomainAccess();
    const allDomains = [...access.active, ...access.frozen];

    const domainsList = await Promise.all(
      allDomains.map(async (domain) => {
        const snapshot = await getDomainSnapshot(domain);
        return { domain, snapshot, active: access.active.includes(domain) };
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

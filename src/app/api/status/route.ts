import { NextRequest, NextResponse } from "next/server";
import { getDomainStatus } from "@/lib/storage";
import {
  badRequest,
  enforceRateLimit,
  getRequestId,
  internalError,
  logServerError,
} from "@/lib/api-helpers";
import { requireAuth } from "@/lib/auth-server";

/**
 * GET /api/status?domain=<domain>
 *
 * Computes the stability classification for a domain by:
 * 1. Retrieving the latest diff between snapshots
 * 2. Applying classification rules
 * 3. Returning status (stable | drift | risk) and triggered signals
 *
 * Returns 400 if domain parameter is missing.
 * Returns 500 on server error.
 */
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
    const domain = request.nextUrl.searchParams.get("domain");

    if (!domain) {
      return badRequest("domain parameter is required", requestId);
    }

    const status = await getDomainStatus(domain.toLowerCase().trim());

    return NextResponse.json(status);
  } catch (error) {
    logServerError(requestId, "Error computing domain status", error);
    return internalError("Failed to compute domain status", requestId);
  }
}

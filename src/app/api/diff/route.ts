import { NextRequest, NextResponse } from "next/server";
import { getDomainDiff } from "@/lib/storage";
import {
  badRequest,
  enforceRateLimit,
  getRequestId,
  internalError,
  logServerError,
} from "@/lib/api-helpers";
import { requireAuth } from "@/lib/auth-server";

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
      return badRequest("Domain query parameter is required", requestId);
    }

    const normalizedDomain = domain.toLowerCase().trim();
    const diffs = await getDomainDiff(normalizedDomain);

    return NextResponse.json(diffs);
  } catch (error) {
    logServerError(requestId, "Diff API error", error);
    return internalError("Failed to compute diff", requestId);
  }
}

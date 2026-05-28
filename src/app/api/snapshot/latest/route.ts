import { NextRequest, NextResponse } from "next/server";
import { getLatestSnapshot } from "@/lib/storage";
import {
  badRequest,
  enforceRateLimit,
  getRequestId,
  internalError,
  logServerError,
  notFound,
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
    const snapshot = await getLatestSnapshot(normalizedDomain);

    if (!snapshot) {
      return notFound("No snapshot found for domain", requestId);
    }

    return NextResponse.json(snapshot);
  } catch (error) {
    logServerError(requestId, "Latest snapshot API error", error);
    return internalError("Failed to retrieve latest snapshot", requestId);
  }
}

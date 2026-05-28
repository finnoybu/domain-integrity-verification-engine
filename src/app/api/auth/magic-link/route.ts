import { NextRequest, NextResponse } from "next/server";
import { issueMagicLink } from "@/lib/auth";
import { resolveBaseUrl } from "@/lib/auth-server";
import {
  badRequest,
  enforceRateLimit,
  errorResponse,
  getRequestId,
  internalError,
  logServerError,
} from "@/lib/api-helpers";

/**
 * POST /api/auth/magic-link  { email }
 *
 * Issues and emails a single-use sign-in link. The response is uniform —
 * `{ sent: true }` — whether or not the email belongs to a registered user, so
 * the endpoint never enumerates the users table. The per-email 3/15min cap is
 * enforced inside issueMagicLink (in addition to the optional IP rate limit
 * here).
 */
export async function POST(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) return rateLimited;

  try {
    const body = await request.json().catch(() => null);
    const email = body?.email;
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return badRequest("A valid email address is required", requestId);
    }

    const result = await issueMagicLink(email, resolveBaseUrl(request));

    if (!result.ok && result.code === "rate_limited") {
      const response = errorResponse(
        "rate_limited",
        "Too many sign-in requests for this email. Please wait and try again.",
        429,
        { requestId },
      );
      response.headers.set(
        "Retry-After",
        String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
      );
      return response;
    }

    // Uniform success shape — does not reveal whether the email is registered.
    return NextResponse.json({ sent: true });
  } catch (error) {
    logServerError(requestId, "magic-link issue error", error);
    return internalError("Failed to send sign-in link", requestId);
  }
}

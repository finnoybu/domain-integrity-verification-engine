import { NextRequest, NextResponse } from "next/server";
import { consumeMagicLink, createSession } from "@/lib/auth";
import { resolveBaseUrl, setSessionCookie } from "@/lib/auth-server";

/**
 * GET /auth/verify?token=...
 *
 * Magic-link consumption endpoint (a GET because it's opened from an email
 * client). On a valid token: burns it, creates a session, sets the session
 * cookie, and redirects to the dashboard root. On any failure: redirects back
 * to /login with an error code so the form can show a useful message.
 */
export async function GET(request: NextRequest) {
  const base = resolveBaseUrl(request);
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(`${base}/login?error=missing_token`);
  }

  const result = consumeMagicLink(token);
  if (!result.ok) {
    return NextResponse.redirect(`${base}/login?error=${result.reason}`);
  }

  const session = createSession(result.user.id);
  const response = NextResponse.redirect(`${base}/`);
  setSessionCookie(response, session.plaintext, session.expiresAt);
  return response;
}

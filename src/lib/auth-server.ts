import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "./auth";

// ============================================================================
// Next.js-coupled auth glue: session cookie read/write/clear and base-URL
// resolution. Kept separate from src/lib/auth.ts so that module stays
// framework-agnostic (and unit-testable without a request object).
//
// requireAuth() — the route-level session-OR-bearer gate — is added here in
// the slice that retires the single-shared AUTH_TOKEN middleware.
// ============================================================================

// Secure cookies require HTTPS at the browser. DIVE expects TLS in production
// (Caddy in docs/deployment.md), so default Secure on in prod. The escape
// hatch is for the rare plain-HTTP prod deployment where Secure would silently
// break sign-in.
const cookieSecure =
  process.env.DIVE_INSECURE_COOKIES === "true"
    ? false
    : process.env.NODE_ENV === "production";

/**
 * Resolves the externally-visible base URL for building links (magic-link
 * email, post-sign-in redirects). Prefers an explicit DIVE_BASE_URL — behind a
 * reverse proxy the request's own origin can be an internal address — and
 * falls back to forwarded headers, then the request URL.
 */
export function resolveBaseUrl(request: NextRequest): string {
  const configured = process.env.DIVE_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");

  const proto =
    request.headers.get("x-forwarded-proto") ??
    request.nextUrl.protocol.replace(/:$/, "");
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host;
  return `${proto}://${host}`;
}

export function readSessionCookie(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

export function setSessionCookie(
  response: NextResponse,
  plaintext: string,
  expiresAt: Date,
): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: plaintext,
    httpOnly: true,
    secure: cookieSecure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

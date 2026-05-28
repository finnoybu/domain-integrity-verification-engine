import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE_NAME,
  getSession,
  verifyApiToken,
  type SessionInfo,
} from "./auth";
import { authRequired } from "./api-helpers";

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

// ----------------------------------------------------------------------------
// Authoritative, DB-backed auth checks. These run on the Node runtime (route
// handlers and server components) — unlike the Edge proxy.ts backstop, which
// can only inspect credential presence.
// ----------------------------------------------------------------------------

export interface AuthedActor {
  userId: number;
  /** Which credential authenticated the request. */
  via: "session" | "api_token";
}

export type RequireAuthResult =
  | { ok: true; actor: AuthedActor }
  | { ok: false; response: NextResponse };

/**
 * API-route auth gate. Accepts EITHER an `Authorization: Bearer <token>`
 * matching an active api_tokens row (integrations, scripts) OR a valid session
 * cookie (the dashboard's own fetch calls). Returns the authenticated actor or
 * a ready-to-return 401.
 *
 *   const auth = requireAuth(request);
 *   if (!auth.ok) return auth.response;
 *   // ... auth.actor.userId
 */
export function requireAuth(request: NextRequest): RequireAuthResult {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    const verified = verifyApiToken(token);
    if (verified) {
      return { ok: true, actor: { userId: verified.userId, via: "api_token" } };
    }
    // A presented-but-invalid bearer token is an explicit failure — don't fall
    // through to cookie auth for an API client that meant to use a token.
    return { ok: false, response: authRequired() };
  }

  const session = getSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (session) {
    return { ok: true, actor: { userId: session.user.id, via: "session" } };
  }

  return { ok: false, response: authRequired() };
}

/**
 * Server-component page guard. Validates the session cookie and redirects to
 * /login when absent or invalid. Returns the live session on success so the
 * page can render user-aware chrome.
 *
 *   const { user } = await requirePageSession();
 */
export async function requirePageSession(): Promise<SessionInfo> {
  const store = await cookies();
  const session = getSession(store.get(SESSION_COOKIE_NAME)?.value);
  if (!session) {
    redirect("/login");
  }
  return session;
}

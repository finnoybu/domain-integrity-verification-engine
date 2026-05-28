import { NextRequest, NextResponse } from "next/server";
import { authRequired } from "@/lib/api-helpers";
import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";

// ============================================================================
// Edge-runtime auth backstop.
//
// This replaces the old single-shared-AUTH_TOKEN gate. It runs on the Edge
// runtime and cannot reach SQLite, so it performs only cheap, presence-level
// checks:
//
//   - lets the sign-in flow and static assets through unauthenticated
//   - bounces credential-less page requests to /login (clean UX)
//   - rejects credential-less /api/* calls with 401 before they hit a route
//
// AUTHORITATIVE validation lives downstream on the Node runtime:
//   - requireAuth()        in API routes (session cookie OR api_tokens bearer)
//   - requirePageSession() in server-component pages (session cookie)
//
// So a present-but-invalid credential passes this layer and is rejected by the
// authoritative check — defense in depth, not the sole gate.
// ============================================================================

const STATIC_PREFIXES = ["/_next/", "/static/"];
const STATIC_EXACT = new Set(["/favicon.ico", "/robots.txt"]);

function isStaticPath(pathname: string): boolean {
  if (STATIC_EXACT.has(pathname)) return true;
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Paths that must be reachable without any credential — the sign-in flow. */
function isPublicPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  if (pathname === "/auth/verify") return true;
  if (pathname.startsWith("/api/auth/")) return true;
  return false;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (isStaticPath(pathname) || isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const hasBearer = (request.headers.get("authorization") ?? "").startsWith("Bearer ");

  if (pathname.startsWith("/api/")) {
    if (hasSession || hasBearer) {
      return NextResponse.next();
    }
    return authRequired();
  }

  // Page request: a session cookie must be present (validity is checked by the
  // page's own requirePageSession). Otherwise redirect to sign-in.
  if (hasSession) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/:path*"],
};

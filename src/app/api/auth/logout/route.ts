import { NextRequest, NextResponse } from "next/server";
import { revokeSession } from "@/lib/auth";
import { clearSessionCookie, readSessionCookie } from "@/lib/auth-server";

/**
 * POST /api/auth/logout
 *
 * Revokes the current session server-side and clears the cookie. Safe to call
 * without a valid session (idempotent) — revokeSession no-ops on an unknown
 * token. The client redirects to /login after a 200.
 */
export async function POST(request: NextRequest) {
  revokeSession(readSessionCookie(request));
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Posts to /api/auth/logout (revokes the session + clears the cookie) then
 * navigates to /login. Minimal chrome for PR 3 — the full /account page with
 * session management is a post-v0.3.0 follow-up.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Even if the network call fails, send the user to /login — the cookie
      // clear is best-effort and the session check there will catch them.
    }
    window.location.href = "/login";
  }

  return (
    <Button variant="outline" size="sm" onClick={signOut} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </Button>
  );
}

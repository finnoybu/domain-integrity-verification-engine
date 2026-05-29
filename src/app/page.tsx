import { requirePageSession } from "@/lib/auth-server";
import { DashboardClient } from "./dashboard-client";
import { SignOutButton } from "./sign-out-button";

/**
 * Dashboard root. Server component: enforces a valid session (redirects to
 * /login otherwise) before rendering the existing client dashboard. The thin
 * header is interim chrome — PR 4 replaces it with the real app-router nav and
 * /account page; the guard pattern (validate, then render) carries forward.
 */
export default async function Home() {
  const { user } = await requirePageSession();
  return (
    <>
      <header className="flex items-center justify-between border-b border-border px-4 py-2 text-sm">
        <span className="font-medium">DIVE</span>
        <div className="flex items-center gap-3 text-muted-foreground">
          <span>{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <DashboardClient />
    </>
  );
}

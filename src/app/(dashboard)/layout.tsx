import { requirePageSession } from "@/lib/auth-server";
import { DashboardNav } from "./nav";

/**
 * Authenticated app shell. One layout guards every dashboard route group
 * member (Domains, Domain detail, License, Account) — `requirePageSession`
 * redirects unauthenticated requests to /login. Left-nav + content + footer,
 * matching the IA in docs/dashboard-design.md (DNSimple-style list-as-home
 * with left-nav, Linear/Stripe visual restraint).
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await requirePageSession();
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <DashboardNav userEmail={user.email} />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-6 py-6">{children}</main>
        <footer className="border-t border-border px-6 py-4 text-center text-xs text-muted-foreground">
          © 2026 Finnoybu.com. Licensed under the Business Source License 1.1.
          <br />
          Finnoybu.com and subdomains are operated by Finnoybu Operations LLC.
        </footer>
      </div>
    </div>
  );
}

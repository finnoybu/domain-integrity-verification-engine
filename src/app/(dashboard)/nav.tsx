"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { SignOutButton } from "../sign-out-button";

const NAV_LINKS = [
  { href: "/domains", label: "Domains" },
  { href: "/alerts", label: "Alerts" },
  { href: "/settings", label: "Settings" },
  { href: "/license", label: "License" },
  { href: "/account", label: "Account" },
];

export function DashboardNav({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="px-4 py-4 text-lg font-semibold tracking-tight">DIVE</div>
      <nav className="flex-1 space-y-1 px-2">
        {NAV_LINKS.map((link) => {
          const active =
            pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "block rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50",
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border px-3 py-3">
        <div
          className="mb-2 truncate text-xs text-muted-foreground"
          title={userEmail}
        >
          {userEmail}
        </div>
        <SignOutButton />
      </div>
    </aside>
  );
}

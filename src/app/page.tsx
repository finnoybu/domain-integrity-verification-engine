import { redirect } from "next/navigation";

/**
 * Root entry. Redirects to the Domains list (the dashboard home per
 * docs/dashboard-design.md). Unauthenticated visitors are bounced to /login by
 * the (dashboard) route group's layout guard, so this needs no session check
 * of its own.
 */
export default function Home() {
  redirect("/domains");
}

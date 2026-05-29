import type { Metadata } from "next";
import { requirePageSession } from "@/lib/auth-server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SignOutButton } from "../../sign-out-button";

export const metadata: Metadata = { title: "Account — DIVE" };

/**
 * Current-user page. Team management (inviting other users) is a deferred
 * post-v0.3.0 follow-up per the design's Decisions section; for now this shows
 * the signed-in identity and the sign-out control.
 */
export default async function AccountPage() {
  const { user } = await requirePageSession();
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-2xl font-semibold">Account</h1>
      <Card>
        <CardHeader>
          <CardTitle className="break-all">{user.email}</CardTitle>
          <CardDescription>
            {user.isAdmin ? "Administrator" : "Operator"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <div className="space-y-1">
            <div>
              Member since{" "}
              <span className="text-foreground">{user.createdAt}</span>
            </div>
            <div>
              Last signed in{" "}
              <span className="text-foreground">
                {user.lastSignedInAt ?? "—"}
              </span>
            </div>
          </div>
          <SignOutButton />
        </CardContent>
      </Card>
    </div>
  );
}

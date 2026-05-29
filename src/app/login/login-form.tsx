"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Maps the ?error=<reason> codes that /auth/verify redirects with onto
 * operator-facing copy. Unknown codes fall through to a generic message.
 */
function describeError(code: string | undefined): string | null {
  switch (code) {
    case undefined:
    case "":
      return null;
    case "missing_token":
      return "That sign-in link was malformed. Request a new one below.";
    case "not_found":
      return "That sign-in link is invalid. Request a new one below.";
    case "expired":
      return "That sign-in link has expired. Request a new one below.";
    case "consumed":
      return "That sign-in link was already used. Request a new one below.";
    case "user_missing":
      return "That account is no longer available. Contact your DIVE administrator.";
    default:
      return "Could not sign you in. Request a new link below.";
  }
}

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

export function LoginForm({ initialError }: { initialError?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>(
    initialError
      ? { kind: "error", message: describeError(initialError) ?? "" }
      : { kind: "idle" },
  );

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.includes("@")) {
      setStatus({ kind: "error", message: "Enter a valid email address." });
      return;
    }
    setStatus({ kind: "submitting" });
    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (response.ok) {
        setStatus({ kind: "sent" });
        return;
      }
      if (response.status === 429) {
        setStatus({
          kind: "error",
          message:
            "Too many sign-in requests for this email. Wait a few minutes and try again.",
        });
        return;
      }
      if (response.status === 400) {
        setStatus({ kind: "error", message: "Enter a valid email address." });
        return;
      }
      setStatus({
        kind: "error",
        message: "Something went wrong sending your link. Try again shortly.",
      });
    } catch {
      setStatus({
        kind: "error",
        message: "Network error. Check your connection and try again.",
      });
    }
  }

  if (status.kind === "sent") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            If {email} has a DIVE account, a sign-in link is on its way. The
            link is valid for 15 minutes and can be used once.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setStatus({ kind: "idle" })}
          >
            Use a different email
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in to DIVE</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send you a single-use sign-in link.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-3">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status.kind === "submitting"}
            aria-label="Email address"
          />
          {status.kind === "error" && status.message ? (
            <p className="text-sm text-destructive" role="alert">
              {status.message}
            </p>
          ) : null}
        </CardContent>
        <CardFooter className="mt-4">
          <Button
            type="submit"
            className="w-full"
            disabled={status.kind === "submitting"}
          >
            {status.kind === "submitting" ? "Sending…" : "Send sign-in link"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

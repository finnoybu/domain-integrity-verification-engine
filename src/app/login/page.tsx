import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in — DIVE",
};

/**
 * Magic-link request page. Server component so it can read the ?error code that
 * /auth/verify redirects with and seed the client form's initial state.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <LoginForm initialError={error} />
    </main>
  );
}

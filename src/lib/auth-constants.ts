// Edge-runtime-safe auth constants. Deliberately free of node:crypto /
// better-sqlite3 / nodemailer imports so the proxy (Edge middleware) can read
// the session cookie name without dragging the DB-backed auth module into the
// Edge bundle. src/lib/auth.ts re-exports SESSION_COOKIE_NAME from here so
// existing importers are unaffected.
export const SESSION_COOKIE_NAME = "dive_session";

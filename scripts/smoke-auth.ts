/**
 * Smoke test for the auth state machine (src/lib/auth.ts). Runs against an
 * isolated DB via DIVE_DATA_DIR so it never touches production data/dive.db.
 *
 * Covers the SMTP-free paths:
 *   - ADMIN_BOOTSTRAP_EMAIL seeding (first boot only, idempotent)
 *   - magic-link consume: valid / expired / consumed / unknown
 *   - magic-link rate limit (3 / 15 min per email) and unknown-email no-op
 *   - sessions: create, validate w/ sliding renewal, revoke, expiry
 *   - api tokens: mint, verify, last-used, revoke, adopt (legacy AUTH_TOKEN)
 *
 * The actual email send in issueMagicLink is exercised manually / in the route
 * integration; here we drive consumeMagicLink against directly-inserted rows.
 *
 * Run: `npx tsx scripts/smoke-auth.ts`  (exits 0 on pass, 1 on any failure)
 */

import fs from "fs";
import os from "os";
import path from "path";

// Isolate the DB before any module reads it. Must precede the auth/db imports.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dive-auth-smoke-"));
process.env.DIVE_DATA_DIR = TMP_DIR;
process.env.ADMIN_BOOTSTRAP_EMAIL = "admin@example.test";
// Ensure no stray real SMTP/from config interferes; we never call send here.
delete process.env.DIVE_AUTH_FROM;

const failures: string[] = [];
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures.push(label);
  }
}

async function main(): Promise<void> {
  const { getDb, closeDb } = await import("../src/lib/db");
  const auth = await import("../src/lib/auth");

  // --- bootstrap ---------------------------------------------------------
  let db = getDb(); // triggers migration + bootstrap seed
  const admin = auth.getUserByEmail("admin@example.test");
  check("bootstrap seeded admin user", !!admin && admin.isAdmin);
  check("bootstrap is idempotent (one user)", auth.listUsers().length === 1);

  // Re-open: bootstrap must not duplicate. Re-fetch the handle — closeDb()
  // invalidated the prior one.
  closeDb();
  db = getDb();
  check("bootstrap idempotent across reopen", auth.listUsers().length === 1);

  const adminId = auth.getUserByEmail("admin@example.test")!.id;

  // --- magic link: consume paths ----------------------------------------
  const { _internal } = auth;
  // Match production storage: expires_at is an ISO-8601 string (toISOString).
  const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
  const validPlain = _internal.randomToken();
  db.prepare(
    `INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)`,
  ).run(_internal.hashToken(validPlain), "admin@example.test", isoIn(15 * 60 * 1000));

  const expiredPlain = _internal.randomToken();
  db.prepare(
    `INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)`,
  ).run(_internal.hashToken(expiredPlain), "admin@example.test", isoIn(-60 * 1000));

  check("consume unknown token → not_found", auth.consumeMagicLink("nope").ok === false);
  check("consume expired token → expired", (() => {
    const r = auth.consumeMagicLink(expiredPlain);
    return !r.ok && r.reason === "expired";
  })());

  const consumed = auth.consumeMagicLink(validPlain);
  check("consume valid token → ok + correct user", consumed.ok && consumed.user.id === adminId);
  check("consume same token twice → consumed", auth.consumeMagicLink(validPlain).ok === false);

  // --- magic link: rate limit + unknown-email no-op ----------------------
  // issueMagicLink for an unknown email returns sent:false without sending.
  const unknown = await auth.issueMagicLink("ghost@example.test", "https://dive.test");
  check("issueMagicLink unknown email → ok, sent:false", unknown.ok === true && unknown.sent === false);

  // Simulate 3 issuances in-window for a rate-limited address, then assert the
  // 4th is blocked. Insert directly to avoid needing SMTP.
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))`,
    ).run(_internal.hashToken(_internal.randomToken()), "rate@example.test");
  }
  db.prepare(`INSERT INTO users (email) VALUES (?)`).run("rate@example.test");
  const limited = await auth.issueMagicLink("rate@example.test", "https://dive.test");
  check("issueMagicLink over cap → rate_limited", limited.ok === false && limited.code === "rate_limited");
  check("rate_limited carries positive retryAfterMs", !limited.ok && limited.retryAfterMs > 0);

  // --- sessions ----------------------------------------------------------
  const sess = auth.createSession(adminId);
  check("createSession returns plaintext + future expiry", !!sess.plaintext && sess.expiresAt.getTime() > Date.now());
  const info = auth.getSession(sess.plaintext);
  check("getSession resolves user", !!info && info.user.id === adminId);
  check("createSession set users.last_signed_in_at", !!auth.getUserById(adminId)!.lastSignedInAt);

  // Sliding renewal: expiry should be pushed forward on read.
  db.prepare(`UPDATE sessions SET expires_at = ? WHERE user_id = ?`).run(isoIn(60 * 60 * 1000), adminId);
  const renewed = auth.getSession(sess.plaintext);
  check("getSession slid expiry forward (~30d)", !!renewed && (Date.parse(renewed.expiresAt) - Date.now()) > 29 * 24 * 60 * 60 * 1000);

  check("getSession unknown → null", auth.getSession("bogus") === null);

  // Expired session is rejected and swept.
  const expiredSess = auth.createSession(adminId);
  db.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`)
    .run(isoIn(-60 * 1000), _internal.hashToken(expiredSess.plaintext));
  check("getSession expired → null", auth.getSession(expiredSess.plaintext) === null);
  check("expired session swept from table", (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?`).get(_internal.hashToken(expiredSess.plaintext)) as { c: number }).c === 0);

  auth.revokeSession(sess.plaintext);
  check("revokeSession removes the session", auth.getSession(sess.plaintext) === null);

  // --- api tokens --------------------------------------------------------
  const minted = auth.mintApiToken(adminId, "monitor-cron");
  check("mintApiToken returns prefixed plaintext", minted.plaintext.startsWith("dive_pat_"));
  const verified = auth.verifyApiToken(minted.plaintext);
  check("verifyApiToken resolves user + token id", !!verified && verified.userId === adminId && verified.tokenId === minted.id);
  check("verifyApiToken stamps last_used_at", !!auth.listApiTokensForUser(adminId).find((t) => t.id === minted.id)?.lastUsedAt);
  check("verifyApiToken unknown → null", auth.verifyApiToken("dive_pat_nope") === null);

  // Adopt path (legacy AUTH_TOKEN value preserved verbatim).
  const legacyPlain = "legacy-shared-token-value";
  auth.adoptApiToken(adminId, "legacy AUTH_TOKEN env", legacyPlain);
  check("adoptApiToken verifies with original plaintext", auth.verifyApiToken(legacyPlain)?.userId === adminId);

  // Revoke.
  check("revokeApiToken returns true once", auth.revokeApiToken(minted.id) === true);
  check("revoked token no longer verifies", auth.verifyApiToken(minted.plaintext) === null);
  check("revokeApiToken second time → false", auth.revokeApiToken(minted.id) === false);

  closeDb();
}

main()
  .catch((err) => {
    console.error("smoke-auth fatal:", err);
    failures.push("fatal: " + (err instanceof Error ? err.message : String(err)));
  })
  .finally(() => {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (failures.length > 0) {
      console.error(`\n✗ smoke-auth: ${failures.length} failure(s)`);
      process.exit(1);
    }
    console.log("\n✓ smoke-auth: all checks passed");
    process.exit(0);
  });

import crypto from "crypto";
import { getDb } from "./db";
import { sendEmail } from "./email";

// ============================================================================
// Auth — magic-link sign-in, server-side sessions, API tokens.
//
// Pure-ish functions over the SQLite schema v2 tables; no Next.js coupling
// (routes own request/response and cookie wiring, this module owns the auth
// state machine). Sessions and API tokens are random 256-bit secrets stored
// only as SHA-256 hashes — a stolen DB file yields no usable credentials.
//
// The bootstrap path (ADMIN_BOOTSTRAP_EMAIL seeding) lives in ./db.ts next to
// the migration ladder; this module assumes the users table is already
// reachable.
// ============================================================================

export const SESSION_COOKIE_NAME = "dive_session";

/** 30-day session lifetime; renewed (sliding) on every successful getSession. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 15-minute magic-link lifetime; single-use. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/** Magic-link rate cap per email, per the design's Decisions section. */
export const MAGIC_LINK_RATE_LIMIT = 3;
export const MAGIC_LINK_RATE_WINDOW_MS = 15 * 60 * 1000;

/** Distinct prefix so a leaked API token is recognizable in logs / repos. */
const API_TOKEN_PREFIX = "dive_pat_";

// ----------------------------------------------------------------------------
// Token helpers.
// ----------------------------------------------------------------------------

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ----------------------------------------------------------------------------
// Users.
// ----------------------------------------------------------------------------

export interface UserRecord {
  id: number;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  lastSignedInAt: string | null;
}

interface UserRow {
  id: number;
  email: string;
  is_admin: number;
  created_at: string;
  last_signed_in_at: string | null;
}

function rowToUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
    lastSignedInAt: row.last_signed_in_at,
  };
}

export function getUserById(id: number): UserRecord | null {
  const row = getDb()
    .prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?")
    .get(id);
  return row ? rowToUser(row) : null;
}

export function getUserByEmail(email: string): UserRecord | null {
  const row = getDb()
    .prepare<[string], UserRow>("SELECT * FROM users WHERE email = ?")
    .get(normalizeEmail(email));
  return row ? rowToUser(row) : null;
}

export function listUsers(): UserRecord[] {
  return getDb()
    .prepare<[], UserRow>("SELECT * FROM users ORDER BY id ASC")
    .all()
    .map(rowToUser);
}

// ----------------------------------------------------------------------------
// Magic links — issue + consume.
// ----------------------------------------------------------------------------

export type IssueMagicLinkResult =
  | {
      ok: true;
      /**
       * `true` when an email was dispatched; `false` when the requested
       * address is not a registered user (silent no-op so the response shape
       * doesn't enumerate the users table).
       */
      sent: boolean;
    }
  | { ok: false; code: "rate_limited"; retryAfterMs: number };

/**
 * Issues a magic-link sign-in token for `email` and emails it as a link of the
 * form `${baseUrl}/auth/verify?token=...`. Single-use, 15-minute TTL.
 *
 * - If `email` is not a known user: returns `{ ok: true, sent: false }` and
 *   does nothing else. Same response shape as success so the caller cannot
 *   enumerate users by API response (timing leak is acknowledged — see the
 *   design doc; out of threat scope for an internal-ops product).
 * - If the per-email rate limit (3 / 15 min) is hit: returns
 *   `{ ok: false, code: "rate_limited", retryAfterMs }`.
 * - On success: inserts the hashed token, then sends the email; throws if
 *   SMTP fails (the orphan magic_links row expires harmlessly in 15 min, the
 *   caller surfaces a 500).
 *
 * `DIVE_AUTH_FROM` env var is the sender address (required to actually send).
 */
export async function issueMagicLink(
  email: string,
  baseUrl: string,
): Promise<IssueMagicLinkResult> {
  const normalized = normalizeEmail(email);
  const user = getUserByEmail(normalized);

  // Always do the rate-limit check first — silent no-op responses for unknown
  // emails would otherwise let an attacker probe rate-limit state to enumerate.
  const rateState = checkMagicLinkRate(normalized);
  if (rateState.limited) {
    return {
      ok: false,
      code: "rate_limited",
      retryAfterMs: rateState.retryAfterMs,
    };
  }

  if (!user) {
    return { ok: true, sent: false };
  }

  const from = process.env.DIVE_AUTH_FROM;
  if (!from) {
    throw new Error(
      "DIVE_AUTH_FROM is not set; magic-link sign-in cannot send mail. Set it to the address you want sign-in links sent from (and ensure DIVE_SMTP_* are configured).",
    );
  }

  const plaintext = randomToken();
  const tokenHash = hashToken(plaintext);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();

  getDb()
    .prepare(
      `INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)`,
    )
    .run(tokenHash, normalized, expiresAt);

  const link = `${baseUrl.replace(/\/$/, "")}/auth/verify?token=${encodeURIComponent(plaintext)}`;

  await sendEmail({
    from,
    to: normalized,
    subject: "Your DIVE sign-in link",
    text: [
      `Sign in to DIVE:`,
      ``,
      link,
      ``,
      `This link is valid for 15 minutes and can be used once.`,
      `If you didn't request it, you can ignore this email.`,
    ].join("\n"),
  });

  return { ok: true, sent: true };
}

interface RateState {
  limited: boolean;
  retryAfterMs: number;
}

function checkMagicLinkRate(email: string): RateState {
  // Count issued (regardless of consumed) within the rolling window. The
  // intent is to cap email send-rate, not redemptions — even an already-burned
  // link still cost an email. The window math runs entirely in SQLite so it
  // doesn't depend on the stored timestamp format (created_at comes from the
  // column DEFAULT datetime('now')); retry_ms is milliseconds until the
  // earliest in-window link ages out.
  const windowMinutes = Math.round(MAGIC_LINK_RATE_WINDOW_MS / 60000);
  const row = getDb()
    .prepare<[string], { c: number; retry_ms: number | null }>(
      `SELECT COUNT(*) AS c,
              CAST(
                (julianday(MIN(created_at), '+${windowMinutes} minutes')
                 - julianday('now')) * 86400000
                AS INTEGER
              ) AS retry_ms
       FROM magic_links
       WHERE email = ?
         AND datetime(created_at) > datetime('now', '-${windowMinutes} minutes')`,
    )
    .get(email);

  const count = row?.c ?? 0;
  if (count < MAGIC_LINK_RATE_LIMIT) {
    return { limited: false, retryAfterMs: 0 };
  }
  return { limited: true, retryAfterMs: Math.max(0, row?.retry_ms ?? 0) };
}

export type ConsumeMagicLinkResult =
  | { ok: true; user: UserRecord }
  | { ok: false; reason: "not_found" | "expired" | "consumed" | "user_missing" };

/**
 * Validates and burns a magic-link token. On success the link is marked
 * consumed (single-use) and the corresponding user is returned. The caller is
 * responsible for creating a session for that user.
 */
export function consumeMagicLink(plaintext: string): ConsumeMagicLinkResult {
  if (!plaintext) return { ok: false, reason: "not_found" };
  const db = getDb();
  const tokenHash = hashToken(plaintext);
  const row = db
    .prepare<
      [string],
      { email: string; expires_at: string; consumed_at: string | null }
    >(
      `SELECT email, expires_at, consumed_at
       FROM magic_links
       WHERE token_hash = ?`,
    )
    .get(tokenHash);

  if (!row) return { ok: false, reason: "not_found" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  // expires_at is stored as an ISO-8601 string (toISOString, already
  // UTC/Z-suffixed) — parse as-is. Guard NaN explicitly: `NaN <= now` is
  // false, which would wrongly accept a malformed/expired token, so treat a
  // non-finite parse as expired (fail closed).
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  // Mark consumed before resolving the user so a race between two clicks on
  // the same link can't double-issue a session.
  const update = db
    .prepare(
      `UPDATE magic_links
       SET consumed_at = datetime('now')
       WHERE token_hash = ? AND consumed_at IS NULL`,
    )
    .run(tokenHash);
  if (update.changes !== 1) {
    return { ok: false, reason: "consumed" };
  }

  const user = getUserByEmail(row.email);
  if (!user) {
    // User was deleted between the link being issued and consumed. Rare; treat
    // as a clean failure rather than crashing the route.
    return { ok: false, reason: "user_missing" };
  }
  return { ok: true, user };
}

// ----------------------------------------------------------------------------
// Sessions — create, validate (with sliding renewal), revoke.
// ----------------------------------------------------------------------------

export interface CreatedSession {
  plaintext: string;
  expiresAt: Date;
}

export function createSession(userId: number): CreatedSession {
  const plaintext = randomToken();
  const tokenHash = hashToken(plaintext);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
  ).run(tokenHash, userId, expiresAt.toISOString());

  // Sign-in timestamp on the user row, separate from session activity, so the
  // /account UI can show "last signed in at" even after a session ends.
  db.prepare(
    `UPDATE users SET last_signed_in_at = datetime('now') WHERE id = ?`,
  ).run(userId);

  return { plaintext, expiresAt };
}

export interface SessionInfo {
  user: UserRecord;
  expiresAt: string;
}

/**
 * Validates a session cookie value and slides the expiry forward by the full
 * TTL on every successful read. Returns null for missing, unknown, or expired
 * sessions (and lazily deletes expired rows so they don't accumulate).
 */
export function getSession(plaintext: string | undefined | null): SessionInfo | null {
  if (!plaintext) return null;
  const tokenHash = hashToken(plaintext);
  const db = getDb();

  const row = db
    .prepare<
      [string],
      { user_id: number; expires_at: string }
    >(
      `SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`,
    )
    .get(tokenHash);

  if (!row) return null;

  // expires_at stored as ISO-8601 (toISOString). Fail closed on a non-finite
  // parse — see consumeMagicLink for the NaN rationale.
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    return null;
  }

  const user = getUserById(row.user_id);
  if (!user) {
    // Orphan session (user deleted while session was active). Drop it.
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    return null;
  }

  const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `UPDATE sessions
     SET last_used_at = datetime('now'), expires_at = ?
     WHERE token_hash = ?`,
  ).run(newExpiresAt, tokenHash);

  return { user, expiresAt: newExpiresAt };
}

export function revokeSession(plaintext: string | undefined | null): void {
  if (!plaintext) return;
  const tokenHash = hashToken(plaintext);
  getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
}

export function revokeAllSessionsForUser(userId: number): void {
  getDb().prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

// ----------------------------------------------------------------------------
// API tokens — mint, verify, list, revoke.
//
// Tokens carry the `dive_pat_` prefix so a leaked token is recognizable in
// logs and code (and rotatable by string match across an org's secret store).
// ----------------------------------------------------------------------------

export interface MintedApiToken {
  id: number;
  plaintext: string;
  name: string;
}

export function mintApiToken(userId: number, name: string): MintedApiToken {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("mintApiToken: 'name' is required (used to identify the token in the UI)");
  }
  const plaintext = `${API_TOKEN_PREFIX}${randomToken()}`;
  const tokenHash = hashToken(plaintext);
  const result = getDb()
    .prepare(
      `INSERT INTO api_tokens (token_hash, user_id, name) VALUES (?, ?, ?)`,
    )
    .run(tokenHash, userId, trimmedName);
  return {
    id: Number(result.lastInsertRowid),
    plaintext,
    name: trimmedName,
  };
}

/**
 * Variant for the v0.3.0 upgrade adoption path — stores an externally-supplied
 * plaintext token (typically the legacy `AUTH_TOKEN` env value) so the
 * existing monitor cron keeps working with zero env churn. The plaintext is
 * never persisted, only its hash.
 */
export function adoptApiToken(
  userId: number,
  name: string,
  plaintext: string,
): { id: number } {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("adoptApiToken: 'name' is required");
  }
  if (!plaintext) {
    throw new Error("adoptApiToken: 'plaintext' is required");
  }
  const tokenHash = hashToken(plaintext);
  const result = getDb()
    .prepare(
      `INSERT INTO api_tokens (token_hash, user_id, name) VALUES (?, ?, ?)`,
    )
    .run(tokenHash, userId, trimmedName);
  return { id: Number(result.lastInsertRowid) };
}

export interface ApiTokenVerification {
  userId: number;
  tokenId: number;
}

export function verifyApiToken(plaintext: string | undefined | null): ApiTokenVerification | null {
  if (!plaintext) return null;
  const tokenHash = hashToken(plaintext);
  const db = getDb();
  const row = db
    .prepare<[string], { id: number; user_id: number }>(
      `SELECT id, user_id
       FROM api_tokens
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .get(tokenHash);
  if (!row) return null;
  db.prepare(
    `UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`,
  ).run(row.id);
  return { userId: row.user_id, tokenId: row.id };
}

export interface ApiTokenSummary {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function listApiTokensForUser(userId: number): ApiTokenSummary[] {
  return getDb()
    .prepare<
      [number],
      {
        id: number;
        name: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }
    >(
      `SELECT id, name, created_at, last_used_at, revoked_at
       FROM api_tokens
       WHERE user_id = ?
       ORDER BY id ASC`,
    )
    .all(userId)
    .map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    }));
}

export function listAllApiTokens(): Array<ApiTokenSummary & { userId: number }> {
  return getDb()
    .prepare<
      [],
      {
        id: number;
        user_id: number;
        name: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }
    >(
      `SELECT id, user_id, name, created_at, last_used_at, revoked_at
       FROM api_tokens
       ORDER BY id ASC`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    }));
}

export function revokeApiToken(id: number): boolean {
  const result = getDb()
    .prepare(
      `UPDATE api_tokens
       SET revoked_at = datetime('now')
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(id);
  return result.changes > 0;
}

// Re-exported helper for tests / scripts that want the canonical hash form
// without re-implementing it. Kept un-prefixed because the prefix is a token
// presentation concern, not a hashing concern.
export const _internal = { hashToken, randomToken };

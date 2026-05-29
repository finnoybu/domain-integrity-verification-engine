import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// ============================================================================
// SQLite storage backend.
//
// Per docs/dashboard-design.md, DIVE's persistent state moves from
// `data/domains.json` (whole-file read/write on every operation, not safe
// under concurrent writes from the web app + monitor tick) to a SQLite
// database file at `data/dive.db`. Snapshot blobs continue to live as JSON
// files in `data/snapshots/<domain>/<ts>.json` — large append-mostly
// artifacts, wrong fit for SQLite.
//
// The "no external services" property of DIVE is preserved: SQLite is a
// file, not a service. No infrastructure to provision, same operational
// model as today (single Node process + filesystem state on disk).
//
// First-run migration imports `data/domains.json` into the new schema, then
// renames the JSON file to `data/domains.json.imported` so the migration
// runs exactly once. The original is preserved as an archive — recovery is
// always possible.
// ============================================================================

// Data directory is resolvable via DIVE_DATA_DIR so tests and one-shot
// scripts can run against an isolated DB instead of the production
// data/dive.db. Defaults to <cwd>/data (the production layout). Resolved at
// getDb() time, not import time, so a test can set the env var before first
// use.
function diveDataDir(): string {
  const override = process.env.DIVE_DATA_DIR;
  return override ? path.resolve(override) : path.join(process.cwd(), "data");
}
function dbFile(): string {
  return path.join(diveDataDir(), "dive.db");
}
function legacyJsonPath(): string {
  return path.join(diveDataDir(), "domains.json");
}
function legacyJsonImportedPath(): string {
  return path.join(diveDataDir(), "domains.json.imported");
}

const CURRENT_SCHEMA_VERSION = 2;

let cached: BetterSqlite3Database | null = null;

/**
 * Returns the singleton SQLite database handle, creating + migrating + WAL-
 * enabling on first call. Idempotent — subsequent calls return the cached
 * connection. Lazy so test environments and one-shot scripts that never touch
 * storage don't pay the open + migrate cost.
 */
export function getDb(): BetterSqlite3Database {
  if (cached) return cached;

  fs.mkdirSync(diveDataDir(), { recursive: true });
  const db = new Database(dbFile());

  // WAL is the right journal mode for a workload with one writer per process
  // (web app, monitor tick) and many concurrent readers — and the monitor
  // tick / dashboard reads can proceed during a write. NORMAL synchronous is
  // safe under WAL and significantly faster than FULL.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  importLegacyJsonIfPresent(db);
  bootstrapAdminFromEnv(db);
  adoptLegacyAuthTokenIfPresent(db);

  cached = db;
  return db;
}

/**
 * Seeds the first admin user from `ADMIN_BOOTSTRAP_EMAIL` on first boot, as
 * decided in docs/dashboard-design.md (matches the env-config pattern used by
 * SMTP / license / retention). Runs once at DB-handle creation; subsequent
 * boots find the user already present and no-op.
 *
 * Lives in db.ts rather than auth.ts to avoid a circular import (auth.ts
 * depends on db.ts for getDb). The seed itself is a single INSERT and stays
 * scoped to first run by the users-empty guard.
 */
function bootstrapAdminFromEnv(db: BetterSqlite3Database): void {
  const raw = (process.env.ADMIN_BOOTSTRAP_EMAIL ?? "").trim().toLowerCase();
  if (!raw) return;
  // Guard against typoed values that would create unusable rows.
  if (!raw.includes("@") || raw.includes(" ")) {
    console.warn(
      `[auth] ADMIN_BOOTSTRAP_EMAIL='${raw}' does not look like an email — skipping bootstrap`,
    );
    return;
  }
  const existing = db
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM users")
    .get();
  if (existing && existing.c > 0) return;

  db.prepare(`INSERT INTO users (email, is_admin) VALUES (?, 1)`).run(raw);
  console.log(`[auth] seeded bootstrap admin from ADMIN_BOOTSTRAP_EMAIL: ${raw}`);
}

/**
 * v0.3.0 upgrade path: adopt an existing `AUTH_TOKEN` env value into the
 * api_tokens table on first boot so installs that used the old single-shared
 * bearer token keep working with zero env churn (the operator's monitor cron /
 * integrations keep sending the same `Authorization: Bearer <AUTH_TOKEN>`).
 *
 * The plaintext is hashed with the same SHA-256 form verifyApiToken uses, so a
 * request bearing the original token matches the adopted row. The legacy token
 * has no `dive_pat_` prefix — verifyApiToken doesn't require one. Operators can
 * rotate it via the dashboard / mint-api-token CLI whenever convenient.
 *
 * Runs once: guarded by an empty api_tokens table (first-run signal). Requires
 * an admin to attach to — bootstrapAdminFromEnv must have run first. Inlined
 * here (rather than calling auth.ts) to avoid an auth↔db import cycle.
 */
function adoptLegacyAuthTokenIfPresent(db: BetterSqlite3Database): void {
  const legacy = process.env.AUTH_TOKEN;
  if (!legacy) return;

  const tokenCount = db
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM api_tokens")
    .get();
  if (tokenCount && tokenCount.c > 0) return;

  const admin = db
    .prepare<[], { id: number }>(
      "SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1",
    )
    .get();
  if (!admin) {
    console.warn(
      "[auth] AUTH_TOKEN is set but no admin user exists to adopt it — set ADMIN_BOOTSTRAP_EMAIL, or mint a token with `npx tsx scripts/mint-api-token.ts` once a user exists.",
    );
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(legacy).digest("hex");
  db.prepare(
    `INSERT INTO api_tokens (token_hash, user_id, name) VALUES (?, ?, ?)`,
  ).run(tokenHash, admin.id, "legacy AUTH_TOKEN (adopted on upgrade)");
  console.log(
    "[auth] adopted existing AUTH_TOKEN into api_tokens — existing Bearer integrations keep working. Rotate it from the dashboard or CLI when convenient.",
  );
}

/**
 * Closes the cached connection. Tests and the migration script use this; the
 * web app and monitor tick leave it open for the process lifetime.
 */
export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

function initSchema(db: BetterSqlite3Database): void {
  // Baseline tables — every supported version has these. CREATE IF NOT EXISTS
  // makes initSchema idempotent across both fresh-DB and existing-DB boots.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS domains (
      name TEXT PRIMARY KEY,
      last_snapshot_json TEXT NOT NULL,
      ownership_token TEXT NOT NULL,
      ownership_state TEXT NOT NULL,
      ownership_verified_at TEXT,
      ownership_failed_at TEXT,
      ownership_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_alerted_stability TEXT,
      last_alerted_ownership TEXT,
      last_alerted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_domains_ownership_state
      ON domains(ownership_state);
  `);

  runMigrations(db);
}

function getStoredVersion(db: BetterSqlite3Database): number {
  const row = db
    .prepare<[], { value: string }>(
      "SELECT value FROM schema_meta WHERE key = 'version'",
    )
    .get();
  return row ? Number(row.value) : 0;
}

function setStoredVersion(db: BetterSqlite3Database, version: number): void {
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(version));
}

/**
 * Walks the migration ladder from the on-disk schema version up to
 * `CURRENT_SCHEMA_VERSION`. Each step is wrapped in a transaction so a partial
 * failure leaves the DB at its previous version — the next boot retries cleanly.
 *
 * Adding a new schema version: bump `CURRENT_SCHEMA_VERSION`, add an
 * `if (current < N)` block here that creates / alters tables and ends with
 * `setStoredVersion(db, N)`.
 */
function runMigrations(db: BetterSqlite3Database): void {
  const current = getStoredVersion(db);

  if (current < 1) {
    // v1 is the baseline shape created by initSchema above — nothing to do
    // beyond stamping the version on a fresh DB.
    setStoredVersion(db, 1);
  }

  if (current < 2) {
    // v2 — auth surface for the v0.3.0 dashboard:
    //   users          one row per operator with sign-in access
    //   sessions       opaque cookie tokens, server-side; 30-day sliding TTL
    //   magic_links    single-use email tokens, 15-minute TTL
    //   api_tokens     replaces the single shared AUTH_TOKEN env path; each
    //                  row is per-user, named, revocable. Token plaintext is
    //                  never stored — only its SHA-256 hash.
    //
    // All token columns store SHA-256 hashes of 256-bit random secrets. At
    // that entropy a generic hash is sufficient; bcrypt would only add cost
    // without buying us anything against a stolen DB file.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          is_admin INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_signed_in_at TEXT
        );

        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

        CREATE TABLE magic_links (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE INDEX idx_magic_links_email ON magic_links(email);
        CREATE INDEX idx_magic_links_expires_at ON magic_links(expires_at);

        CREATE TABLE api_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          revoked_at TEXT
        );
        CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);
      `);
      setStoredVersion(db, 2);
    })();
  }

  // Future migrations append here. Don't ever re-order an existing block.

  // Invariant: every supported version's migration ran; the stored version now
  // equals the code's CURRENT_SCHEMA_VERSION. A mismatch means a migration
  // block is missing for a version the code claims to support.
  const finalVersion = getStoredVersion(db);
  if (finalVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `[db] migration ladder incomplete: stored version ${finalVersion} != code version ${CURRENT_SCHEMA_VERSION}`,
    );
  }
}

interface LegacyOwnership {
  token: string;
  state: string;
  verifiedAt: string | null;
  failedAt: string | null;
  consecutiveFailures: number;
}

interface LegacyLastAlerted {
  stabilityState: string | null;
  ownershipState: string | null;
  lastAlertedAt: string | null;
}

interface LegacyDomainEntry {
  lastSnapshot: unknown;
  ownership: LegacyOwnership;
  lastAlerted?: LegacyLastAlerted;
}

interface LegacyDomainStore {
  domains: Record<string, LegacyDomainEntry>;
}

/**
 * First-run migration: if `data/domains.json` exists (the legacy store) and
 * the `domains` table is empty, import every entry into SQLite and rename
 * the JSON file to `.imported` so this runs exactly once. The original is
 * never deleted — operators can always inspect / restore.
 *
 * Defensive against partial state: if the import throws mid-way the JSON
 * file is left untouched, so a retry sees the same starting condition.
 */
function importLegacyJsonIfPresent(db: BetterSqlite3Database): void {
  const LEGACY_JSON = legacyJsonPath();
  if (!fs.existsSync(LEGACY_JSON)) return;

  // Guard against re-import: only migrate when the table is empty. A
  // populated table on top of a present JSON means a prior run already
  // imported (and either failed to rename or someone restored the JSON
  // manually). Refuse to silently overwrite either side.
  const rowCount = db
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM domains")
    .get();
  if (rowCount && rowCount.c > 0) {
    console.warn(
      `[db] data/domains.json present but domains table already has ${rowCount.c} rows — skipping import. Rename or remove data/domains.json manually if you intend to re-import.`,
    );
    return;
  }

  let parsed: LegacyDomainStore;
  try {
    const raw = fs.readFileSync(LEGACY_JSON, "utf-8");
    parsed = JSON.parse(raw) as LegacyDomainStore;
  } catch (error) {
    console.error(
      `[db] failed to read data/domains.json — leaving it in place and starting with an empty store:`,
      error,
    );
    return;
  }

  const entries = Object.entries(parsed.domains ?? {});
  if (entries.length === 0) {
    // Empty legacy store — nothing to migrate; still archive it so the
    // import doesn't keep firing.
    archiveLegacyJson();
    return;
  }

  const insert = db.prepare(`
    INSERT INTO domains (
      name,
      last_snapshot_json,
      ownership_token,
      ownership_state,
      ownership_verified_at,
      ownership_failed_at,
      ownership_consecutive_failures,
      last_alerted_stability,
      last_alerted_ownership,
      last_alerted_at
    ) VALUES (
      @name,
      @lastSnapshotJson,
      @ownershipToken,
      @ownershipState,
      @ownershipVerifiedAt,
      @ownershipFailedAt,
      @ownershipConsecutiveFailures,
      @lastAlertedStability,
      @lastAlertedOwnership,
      @lastAlertedAt
    )
  `);

  const txn = db.transaction((rows: LegacyDomainEntry[]) => {
    for (const [name, entry] of entries) {
      insert.run({
        name,
        lastSnapshotJson: JSON.stringify(entry.lastSnapshot),
        ownershipToken: entry.ownership.token,
        ownershipState: entry.ownership.state,
        ownershipVerifiedAt: entry.ownership.verifiedAt,
        ownershipFailedAt: entry.ownership.failedAt,
        ownershipConsecutiveFailures: entry.ownership.consecutiveFailures,
        lastAlertedStability: entry.lastAlerted?.stabilityState ?? null,
        lastAlertedOwnership: entry.lastAlerted?.ownershipState ?? null,
        lastAlertedAt: entry.lastAlerted?.lastAlertedAt ?? null,
      });
    }
    // Suppress unused-parameter lint — better-sqlite3's transaction
    // helper requires a callback that takes the iterable, even when
    // we close over `entries` directly.
    void rows;
  });

  try {
    txn(entries.map(([, entry]) => entry));
  } catch (error) {
    console.error(
      `[db] failed to import data/domains.json — leaving it in place; database state rolled back:`,
      error,
    );
    return;
  }

  archiveLegacyJson();
  console.log(
    `[db] imported ${entries.length} domain(s) from data/domains.json → data/dive.db; original archived to data/domains.json.imported`,
  );
}

function archiveLegacyJson(): void {
  const LEGACY_JSON = legacyJsonPath();
  const LEGACY_JSON_IMPORTED = legacyJsonImportedPath();
  try {
    // If a prior partial run left a stale .imported, rotate it so the
    // current archive is the most recent one.
    if (fs.existsSync(LEGACY_JSON_IMPORTED)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      fs.renameSync(LEGACY_JSON_IMPORTED, `${LEGACY_JSON_IMPORTED}.${ts}`);
    }
    fs.renameSync(LEGACY_JSON, LEGACY_JSON_IMPORTED);
  } catch (error) {
    console.error(
      `[db] failed to archive data/domains.json after import — please move it manually:`,
      error,
    );
  }
}

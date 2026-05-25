import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
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

const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "dive.db");
const LEGACY_JSON = path.join(DATA_DIR, "domains.json");
const LEGACY_JSON_IMPORTED = path.join(DATA_DIR, "domains.json.imported");

const CURRENT_SCHEMA_VERSION = 1;

let cached: BetterSqlite3Database | null = null;

/**
 * Returns the singleton SQLite database handle, creating + migrating + WAL-
 * enabling on first call. Idempotent — subsequent calls return the cached
 * connection. Lazy so test environments and one-shot scripts that never touch
 * storage don't pay the open + migrate cost.
 */
export function getDb(): BetterSqlite3Database {
  if (cached) return cached;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_FILE);

  // WAL is the right journal mode for a workload with one writer per process
  // (web app, monitor tick) and many concurrent readers — and the monitor
  // tick / dashboard reads can proceed during a write. NORMAL synchronous is
  // safe under WAL and significantly faster than FULL.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  importLegacyJsonIfPresent(db);

  cached = db;
  return db;
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

  // Track schema version so future migrations can run conditionally.
  const stored = db
    .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key = 'version'")
    .get();
  if (!stored) {
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?)").run(
      String(CURRENT_SCHEMA_VERSION),
    );
  }
  // No upgrades yet — version 1 is the initial schema. When a v2 lands,
  // gate the migration here on `stored.value !== '2'`, run the upgrade,
  // UPDATE schema_meta.
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

import { getDb } from "./db";

// ============================================================================
// Settings — global UI-overridable defaults + per-domain overrides (PR 6).
//
// Resolution: per-domain → global (settings table) → env var → hardcoded
// default. The dashboard can set both layers; clearing them falls back to env
// (operator config) and then to the baked-in default.
//
// Only `monitor_interval_seconds` is per-domain in this PR — the design's
// open question (retention / lookup_timeout per-domain too?) is resolved
// narrowly here. The schema is generic so adding more per-domain keys later
// is a one-line type change, not a migration.
// ============================================================================

export type GlobalSettingKey =
  | "monitor_interval_seconds"
  | "snapshot_retention"
  | "ownership_lookup_timeout_ms";

export type DomainSettingKey = "monitor_interval_seconds";

interface Definition {
  /** Env var name preserved for backward compat (deployment.md docs them). */
  envVar: string;
  /** Hardcoded default if neither DB nor env is set. */
  defaultValue: number;
  /** Inclusive validation range. */
  min: number;
  max: number;
}

const DEFINITIONS: Record<GlobalSettingKey, Definition> = {
  monitor_interval_seconds: {
    envVar: "MONITOR_INTERVAL",
    defaultValue: 3600, // 1 hour
    min: 60,
    max: 7 * 86400, // a week — well beyond any reasonable operator value
  },
  snapshot_retention: {
    envVar: "SNAPSHOT_RETENTION",
    defaultValue: 30,
    min: 2, // the diff engine needs at least the prior snapshot
    max: 10_000,
  },
  ownership_lookup_timeout_ms: {
    envVar: "OWNERSHIP_LOOKUP_TIMEOUT_MS",
    defaultValue: 5_000,
    min: 500,
    max: 60_000,
  },
};

const GLOBAL_KEYS = Object.keys(DEFINITIONS) as GlobalSettingKey[];

function defOf(key: GlobalSettingKey): Definition {
  const def = DEFINITIONS[key];
  if (!def) throw new Error(`unknown setting key: ${key}`);
  return def;
}

function parseInteger(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function validateOrThrow(key: GlobalSettingKey, value: number): number {
  const def = defOf(key);
  if (!Number.isInteger(value) || value < def.min || value > def.max) {
    throw new Error(
      `${key}: value must be an integer in [${def.min}, ${def.max}], got ${value}`,
    );
  }
  return value;
}

// ----------------------------------------------------------------------------
// Global settings.
// ----------------------------------------------------------------------------

/**
 * Returns the effective global value for a key — DB row if present and
 * valid; else the env var if present and in range; else the hardcoded default.
 */
export async function getGlobalSetting(key: GlobalSettingKey): Promise<number> {
  const def = defOf(key);

  const row = getDb()
    .prepare<[string], { value: string }>(
      "SELECT value FROM settings WHERE key = ?",
    )
    .get(key);
  if (row) {
    const n = parseInteger(row.value);
    if (n !== null && n >= def.min && n <= def.max) return n;
  }

  const fromEnv = parseInteger(process.env[def.envVar]);
  if (fromEnv !== null && fromEnv >= def.min && fromEnv <= def.max) {
    return fromEnv;
  }
  return def.defaultValue;
}

export async function setGlobalSetting(
  key: GlobalSettingKey,
  value: number,
): Promise<void> {
  validateOrThrow(key, value);
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, String(value));
}

export async function clearGlobalSetting(key: GlobalSettingKey): Promise<void> {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export interface GlobalSettingView {
  key: GlobalSettingKey;
  effective: number;
  source: "db" | "env" | "default";
  defaultValue: number;
  envVar: string;
  min: number;
  max: number;
}

/** Per-key effective value + provenance, for the /settings UI. */
export async function listGlobalSettings(): Promise<GlobalSettingView[]> {
  const rows = getDb()
    .prepare<[], { key: string; value: string }>(
      "SELECT key, value FROM settings",
    )
    .all();
  const dbValues = new Map(rows.map((r) => [r.key, r.value]));

  return GLOBAL_KEYS.map((key) => {
    const def = defOf(key);
    const dbVal = parseInteger(dbValues.get(key));
    if (dbVal !== null && dbVal >= def.min && dbVal <= def.max) {
      return makeView(key, dbVal, "db", def);
    }
    const envVal = parseInteger(process.env[def.envVar]);
    if (envVal !== null && envVal >= def.min && envVal <= def.max) {
      return makeView(key, envVal, "env", def);
    }
    return makeView(key, def.defaultValue, "default", def);
  });
}

function makeView(
  key: GlobalSettingKey,
  effective: number,
  source: GlobalSettingView["source"],
  def: Definition,
): GlobalSettingView {
  return {
    key,
    effective,
    source,
    defaultValue: def.defaultValue,
    envVar: def.envVar,
    min: def.min,
    max: def.max,
  };
}

// ----------------------------------------------------------------------------
// Per-domain settings.
// ----------------------------------------------------------------------------

/** Returns the per-domain override (no fallback). null = inherit. */
export async function getDomainSetting(
  domain: string,
  key: DomainSettingKey,
): Promise<number | null> {
  const row = getDb()
    .prepare<[string, string], { value: string }>(
      "SELECT value FROM domain_settings WHERE domain = ? AND key = ?",
    )
    .get(domain, key);
  if (!row) return null;
  const n = parseInteger(row.value);
  const def = defOf(key);
  if (n === null || n < def.min || n > def.max) return null;
  return n;
}

export async function setDomainSetting(
  domain: string,
  key: DomainSettingKey,
  value: number,
): Promise<void> {
  validateOrThrow(key, value);
  getDb()
    .prepare(
      `INSERT INTO domain_settings (domain, key, value) VALUES (?, ?, ?)
       ON CONFLICT(domain, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(domain, key, String(value));
}

export async function clearDomainSetting(
  domain: string,
  key: DomainSettingKey,
): Promise<void> {
  getDb()
    .prepare("DELETE FROM domain_settings WHERE domain = ? AND key = ?")
    .run(domain, key);
}

export async function listDomainSettings(
  domain: string,
): Promise<Record<DomainSettingKey, number | null>> {
  const interval = await getDomainSetting(domain, "monitor_interval_seconds");
  return { monitor_interval_seconds: interval };
}

// ----------------------------------------------------------------------------
// Effective resolution + scheduling.
// ----------------------------------------------------------------------------

/**
 * The interval, in seconds, that should govern the next check for this domain.
 * Per-domain override wins if present; otherwise the global value.
 */
export async function effectiveMonitorIntervalSeconds(
  domain: string,
): Promise<number> {
  const perDomain = await getDomainSetting(domain, "monitor_interval_seconds");
  if (perDomain !== null) return perDomain;
  return getGlobalSetting("monitor_interval_seconds");
}

/**
 * Returns the next-check timestamp for a domain (as a Date), based on
 * last_check_at + effective interval. Returns null when the domain has never
 * been checked — interpret as "due immediately".
 */
export async function nextCheckAtForDomain(
  domain: string,
  lastCheckAt: string | null,
): Promise<Date | null> {
  if (!lastCheckAt) return null;
  const ms = Date.parse(lastCheckAt);
  if (!Number.isFinite(ms)) return null;
  const interval = await effectiveMonitorIntervalSeconds(domain);
  return new Date(ms + interval * 1000);
}

export function isDue(nextCheck: Date | null, now: Date = new Date()): boolean {
  if (nextCheck === null) return true;
  return nextCheck.getTime() <= now.getTime();
}

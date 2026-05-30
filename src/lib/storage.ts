import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import tls from "tls";
import { promises as dns } from "dns";
import { getLicenseStatus, type LicenseStatus } from "./license";
import { getDb } from "./db";

export interface DomainSOA {
  primaryNs: string;
  hostmaster: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

export interface DomainSnapshot {
  // Core Identity
  domain: string;
  timestamp: string;

  // Registration Layer (RDAP)
  registrar?: string;
  registrarIanaId?: string;
  registrantOrganization?: string;
  created?: string;
  expires?: string;
  lastUpdated?: string;
  status?: string[];
  dnssec?: boolean;

  // DNS Layer
  nameservers?: string[];
  soa?: DomainSOA | null;
  aRecords?: string[];
  aaaaRecords?: string[];
  cnameRecords?: string[];
  mxRecords?: string[];
  txtRecords?: string[];
  srvRecords?: string[];

  // Infrastructure Layer
  ipAddresses?: string[];
  asn?: string;
  asnName?: string;
  hostingProvider?: string;
  cdnDetected?: boolean;
  ipCountry?: string;

  // TLS / Security Layer
  httpsReachable?: boolean;
  sslIssuer?: string;
  sslSubject?: string;
  sslSans?: string[];
  sslValidFrom?: string;
  sslExpires?: string;
  sslFingerprint?: string;
  hstsEnabled?: boolean;

  // Email Security Layer
  spfRecord?: string;
  dmarcRecord?: string;
  dkimSelectors?: string[];

  // Internal Governance Metadata
  internalOwner?: string;
  licensedTo?: string;
  notes?: string;

  // Level 3: Advanced Registration / RDAP
  rdapEntities?: Record<string, unknown>[];
  rdapRaw?: Record<string, unknown> | null;
  registrantContactEmail?: string;
  registrantCountry?: string;
  registryOperator?: string;

  // Level 3: Advanced DNS Security
  dnskeyRecords?: string[];
  dsRecords?: string[];
  caaRecords?: string[];
  zoneTransferAllowed?: boolean;

  // Level 3: Advanced TLS Analysis
  sslChainValid?: boolean;
  sslChainDepth?: number;
  sslSignatureAlgorithm?: string;
  sslPublicKeyAlgorithm?: string;
  sslKeySize?: number;
  sslOcspStapled?: boolean;

  // Level 3: HTTP Security Headers
  hstsMaxAge?: number;
  hstsPreload?: boolean;
  cspHeaderPresent?: boolean;
  xFrameOptionsPresent?: boolean;
  referrerPolicyPresent?: boolean;

  // Level 3: IP Intelligence
  ipReputationScore?: number;
  ipBlacklistHits?: string[];
  ipRir?: string;
  ipAllocationDate?: string;

  // Level 3: Snapshot Integrity / Monitoring
  snapshotHash?: string;
  previousSnapshotHash?: string;
  changeSummary?: Array<Record<string, unknown>>;
  riskScore?: number;
}

/**
 * Three-state ownership lifecycle per `docs/ownership-verification-design.md`.
 * `unverified` and `failed` short-circuit the snapshot pipeline; only
 * `verified` lets a check proceed.
 */
export type OwnershipState =
  | "ownership_unverified"
  | "ownership_verified"
  | "ownership_failed";

/**
 * Per-domain ownership verification record. The operator publishes `token` as a
 * TXT record at `_dive-challenge.<domain>`; every monitor / snapshot cycle
 * re-resolves it and updates this record. `consecutiveFailures` reaches 3 →
 * `state` becomes `ownership_failed` (see ownership-verification-design.md).
 */
export interface OwnershipRecord {
  token: string;
  state: OwnershipState;
  verifiedAt: string | null;
  failedAt: string | null;
  consecutiveFailures: number;
}

/**
 * Per-domain record of the last classification the monitor *dispatched an
 * alert on*. Used by the alerting layer to deduplicate: alerts fire only
 * when the current state differs from the last alerted one. Optional on the
 * store entry — populated lazily by the alerting code on first observation
 * (so we don't alert-spam at startup).
 */
export interface LastAlertedRecord {
  stabilityState: string | null;
  ownershipState: string | null;
  lastAlertedAt: string | null;
}

// The legacy DomainStore in-memory shape (whole-file JSON) is gone — state
// lives in SQLite via ./db.ts. The per-domain entry below is kept only as an
// internal type for the SQLite row → object adapter in this module.
interface DomainRow {
  name: string;
  last_snapshot_json: string;
  ownership_token: string;
  ownership_state: string;
  ownership_verified_at: string | null;
  ownership_failed_at: string | null;
  ownership_consecutive_failures: number;
  last_alerted_stability: string | null;
  last_alerted_ownership: string | null;
  last_alerted_at: string | null;
  last_check_at: string | null;
}

function rowToOwnership(row: DomainRow): OwnershipRecord {
  return {
    token: row.ownership_token,
    state: row.ownership_state as OwnershipState,
    verifiedAt: row.ownership_verified_at,
    failedAt: row.ownership_failed_at,
    consecutiveFailures: row.ownership_consecutive_failures,
  };
}

function rowToLastAlerted(row: DomainRow): LastAlertedRecord | null {
  // Treat "no alert ever sent" as null on the way out — matches the
  // legacy JSON shape where the field was either present or absent.
  if (
    row.last_alerted_stability === null &&
    row.last_alerted_ownership === null &&
    row.last_alerted_at === null
  ) {
    return null;
  }
  return {
    stabilityState: row.last_alerted_stability,
    ownershipState: row.last_alerted_ownership,
    lastAlertedAt: row.last_alerted_at,
  };
}

/**
 * DNS name at which the operator publishes the per-domain verification token.
 * Isolated from the apex so SPF / DMARC TXT records don't collide.
 */
export function ownershipVerificationRecord(domain: string): string {
  return `_dive-challenge.${domain}`;
}

/**
 * Generates a fresh ownership record with a 32-byte base64url token and a
 * starting `ownership_unverified` state. New domains and lazy migrations of
 * pre-ownership entries both call this.
 */
export function createOwnershipRecord(): OwnershipRecord {
  return {
    token: crypto.randomBytes(32).toString("base64url"),
    state: "ownership_unverified",
    verifiedAt: null,
    failedAt: null,
    consecutiveFailures: 0,
  };
}

/**
 * Snapshots retained per domain. Configurable via the SNAPSHOT_RETENTION
 * environment variable; defaults to 30 (about a month of daily history).
 * A floor of 2 is enforced so the diff engine always has a prior snapshot.
 */
function resolveSnapshotRetention(): number {
  const configured = Number(process.env.SNAPSHOT_RETENTION);
  if (Number.isInteger(configured) && configured >= 2) {
    return configured;
  }
  return 30;
}

export const MAX_SNAPSHOTS_PER_DOMAIN = resolveSnapshotRetention();

/**
 * Returns a canonical base DomainSnapshot with all fields present (v0.0.7 schema).
 * Level 1-2 fields are populated by snapshot queries.
 * Level 3 fields are future-proofing for audit/compliance and remain empty in v0.0.x.
 * All values are initialized to empty/default values appropriate for their type.
 * This serves as the foundation for all snapshot generation.
 */
export function getCanonicalBase(domain: string, timestamp: string = new Date().toISOString()): DomainSnapshot {
  return {
    // Core Identity
    domain,
    timestamp,

    // Registration Layer
    registrar: "",
    registrarIanaId: "",
    registrantOrganization: "",
    created: "",
    expires: "",
    lastUpdated: "",
    status: [],
    dnssec: false,

    // DNS Layer
    nameservers: [],
    soa: null,
    aRecords: [],
    aaaaRecords: [],
    cnameRecords: [],
    mxRecords: [],
    txtRecords: [],
    srvRecords: [],

    // Infrastructure Layer
    ipAddresses: [],
    asn: "",
    asnName: "",
    hostingProvider: "",
    cdnDetected: false,
    ipCountry: "",

    // TLS / Security Layer
    httpsReachable: false,
    sslIssuer: "",
    sslSubject: "",
    sslSans: [],
    sslValidFrom: "",
    sslExpires: "",
    sslFingerprint: "",
    hstsEnabled: false,

    // Email Security Layer
    spfRecord: "",
    dmarcRecord: "",
    dkimSelectors: [],

    // Internal Governance Metadata
    internalOwner: "",
    licensedTo: "",
    notes: "",

    // Level 3: Advanced Registration / RDAP
    rdapEntities: [],
    rdapRaw: null,
    registrantContactEmail: "",
    registrantCountry: "",
    registryOperator: "",

    // Level 3: Advanced DNS Security
    dnskeyRecords: [],
    dsRecords: [],
    caaRecords: [],
    zoneTransferAllowed: false,

    // Level 3: Advanced TLS Analysis
    sslChainValid: false,
    sslChainDepth: 0,
    sslSignatureAlgorithm: "",
    sslPublicKeyAlgorithm: "",
    sslKeySize: 0,
    sslOcspStapled: false,

    // Level 3: HTTP Security Headers
    hstsMaxAge: 0,
    hstsPreload: false,
    cspHeaderPresent: false,
    xFrameOptionsPresent: false,
    referrerPolicyPresent: false,

    // Level 3: IP Intelligence
    ipReputationScore: 0,
    ipBlacklistHits: [],
    ipRir: "",
    ipAllocationDate: "",

    // Level 3: Snapshot Integrity / Monitoring
    snapshotHash: "",
    previousSnapshotHash: "",
    changeSummary: [],
    riskScore: 0,
  };
}

/**
 * Validates that a snapshot has all required DomainSnapshot keys per v0.0.7 schema.
 * Keys may have undefined values, but the keys themselves must exist.
 * Uses canonical base to ensure completeness.
 */
function validateSnapshot(snapshot: DomainSnapshot): DomainSnapshot {
  const canonical = getCanonicalBase(snapshot.domain, snapshot.timestamp);
  const validatedSnapshot = { ...canonical };

  // Merge in provided snapshot values, preserving all canonical keys
  for (const key in snapshot) {
    const value = snapshot[key as keyof DomainSnapshot];
    if (value !== undefined) {
      (validatedSnapshot as Record<string, unknown>)[key] = value;
    }
  }

  return validatedSnapshot;
}

// ----------------------------------------------------------------------------
// SQLite-backed CRUD. All functions keep their Promise-returning signatures
// so callers don't need to change; the underlying better-sqlite3 driver is
// synchronous and we resolve immediately. Async signatures stay forward-
// compatible with a future host-managed backend (Cloudflare D1, etc.) that
// would be naturally async — see docs/dashboard-design.md, Hosting.
// ----------------------------------------------------------------------------

function fetchRow(domain: string): DomainRow | undefined {
  return getDb()
    .prepare<[string], DomainRow>("SELECT * FROM domains WHERE name = ?")
    .get(domain);
}

export async function addDomain(
  domain: string,
  snapshot: DomainSnapshot,
): Promise<void> {
  const validated = validateSnapshot(snapshot);
  const db = getDb();
  const existing = fetchRow(domain);
  if (existing) {
    db.prepare(
      `UPDATE domains
       SET last_snapshot_json = ?, updated_at = datetime('now')
       WHERE name = ?`,
    ).run(JSON.stringify(validated), domain);
    return;
  }

  const ownership = createOwnershipRecord();
  db.prepare(
    `INSERT INTO domains (
       name, last_snapshot_json,
       ownership_token, ownership_state,
       ownership_verified_at, ownership_failed_at, ownership_consecutive_failures
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    domain,
    JSON.stringify(validated),
    ownership.token,
    ownership.state,
    ownership.verifiedAt,
    ownership.failedAt,
    ownership.consecutiveFailures,
  );
}

export async function updateDomain(
  domain: string,
  snapshot: DomainSnapshot,
): Promise<void> {
  const validated = validateSnapshot(snapshot);
  getDb()
    .prepare(
      `UPDATE domains
       SET last_snapshot_json = ?, updated_at = datetime('now')
       WHERE name = ?`,
    )
    .run(JSON.stringify(validated), domain);
}

/**
 * Reserves a slot in the store for a newly added domain without taking a
 * snapshot: mints an ownership token, sets `ownership_unverified`, and
 * records a placeholder canonical snapshot so downstream consumers always see
 * a complete schema. Returns the issued ownership record. Idempotent — if the
 * domain is already registered, the existing record is returned unchanged.
 */
export async function registerDomain(
  domain: string,
  timestamp: string = new Date().toISOString(),
): Promise<OwnershipRecord> {
  const existing = fetchRow(domain);
  if (existing) {
    return rowToOwnership(existing);
  }

  const ownership = createOwnershipRecord();
  getDb()
    .prepare(
      `INSERT INTO domains (
         name, last_snapshot_json,
         ownership_token, ownership_state,
         ownership_verified_at, ownership_failed_at, ownership_consecutive_failures
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      domain,
      // Placeholder snapshot until the first real fetch — keeps the canonical
      // schema invariant intact for any reader that hits the store before
      // ownership is verified.
      JSON.stringify(getCanonicalBase(domain, timestamp)),
      ownership.token,
      ownership.state,
      ownership.verifiedAt,
      ownership.failedAt,
      ownership.consecutiveFailures,
    );
  return ownership;
}

export async function getOwnership(domain: string): Promise<OwnershipRecord | null> {
  const row = fetchRow(domain);
  return row ? rowToOwnership(row) : null;
}

export async function setOwnership(
  domain: string,
  ownership: OwnershipRecord,
): Promise<void> {
  // Silently no-op for unknown domains — preserves the legacy behavior
  // where setOwnership on a missing entry was a write to nothing.
  getDb()
    .prepare(
      `UPDATE domains
       SET ownership_token = ?,
           ownership_state = ?,
           ownership_verified_at = ?,
           ownership_failed_at = ?,
           ownership_consecutive_failures = ?,
           updated_at = datetime('now')
       WHERE name = ?`,
    )
    .run(
      ownership.token,
      ownership.state,
      ownership.verifiedAt,
      ownership.failedAt,
      ownership.consecutiveFailures,
      domain,
    );
}

export async function getLastAlerted(
  domain: string,
): Promise<LastAlertedRecord | null> {
  const row = fetchRow(domain);
  return row ? rowToLastAlerted(row) : null;
}

export async function setLastAlerted(
  domain: string,
  record: LastAlertedRecord,
): Promise<void> {
  getDb()
    .prepare(
      `UPDATE domains
       SET last_alerted_stability = ?,
           last_alerted_ownership = ?,
           last_alerted_at = ?,
           updated_at = datetime('now')
       WHERE name = ?`,
    )
    .run(record.stabilityState, record.ownershipState, record.lastAlertedAt, domain);
}

/**
 * Last time the monitor tick (or an on-demand path that takes a snapshot)
 * actually did work for this domain — null until the first successful
 * snapshot or ownership check. The PR 6 scheduler reads this to decide
 * whether a domain is past-due under its effective interval.
 */
export async function getLastCheckAt(domain: string): Promise<string | null> {
  const row = fetchRow(domain);
  return row?.last_check_at ?? null;
}

export async function setLastCheckAt(
  domain: string,
  timestamp: string = new Date().toISOString(),
): Promise<void> {
  getDb()
    .prepare(
      `UPDATE domains
       SET last_check_at = ?, updated_at = datetime('now')
       WHERE name = ?`,
    )
    .run(timestamp, domain);
}

export async function deleteDomain(domain: string): Promise<boolean> {
  const result = getDb().prepare("DELETE FROM domains WHERE name = ?").run(domain);
  return result.changes > 0;
}

export async function getDomains(): Promise<string[]> {
  // ORDER BY rowid ASC preserves insertion order, matching the legacy JSON
  // store's object-key-iteration semantics. The license capacity layer
  // depends on this ordering (earliest-added domains stay active when the
  // license shrinks; later ones freeze).
  return getDb()
    .prepare<[], { name: string }>("SELECT name FROM domains ORDER BY rowid ASC")
    .all()
    .map((r) => r.name);
}

export async function getDomainSnapshot(domain: string): Promise<DomainSnapshot | null> {
  const row = fetchRow(domain);
  if (!row) return null;
  return JSON.parse(row.last_snapshot_json) as DomainSnapshot;
}

// ============================================================================
// v0.1.1 Snapshot History & Persistence Engine
// ============================================================================

const SNAPSHOTS_DIR = path.join(process.cwd(), "data", "snapshots");

/**
 * Converts ISO timestamp to filesystem-safe format: YYYY-MM-DDTHH-mm-ssZ
 * Uses hyphens instead of colons in time portion for filesystem compatibility.
 */
function timestampToFilename(timestamp: string): string {
  // Convert ISO 8601 (2026-03-02T14:30:45.123Z) to (2026-03-02T14-30-45Z)
  // Remove milliseconds, then replace all colons with hyphens in the time portion
  return timestamp.split(".")[0].replace(/:/g, "-") + "Z";
}

/**
 * Writes snapshot to disk with atomic rename (write to temp file, then rename).
 * Ensures file is fully written before being visible.
 */
async function atomicWriteSnapshot(domain: string, snapshot: DomainSnapshot): Promise<string> {
  const domainDir = path.join(SNAPSHOTS_DIR, domain);
  
  // Ensure domain snapshot directory exists
  await fs.mkdir(domainDir, { recursive: true });

  const filename = timestampToFilename(snapshot.timestamp);
  const filepath = path.join(domainDir, `${filename}.json`);
  
  // Write to temporary file in the same directory to avoid cross-device link errors on Windows
  const tempfile = path.join(
    domainDir,
    `.${filename}.tmp.${Math.random().toString(36).slice(2, 9)}`
  );

  try {
    // Write to temp file
    await fs.writeFile(tempfile, JSON.stringify(snapshot, null, 2), "utf-8");
    
    // Atomic rename (same directory = safe on all platforms)
    await fs.rename(tempfile, filepath);
    
    return filepath;
  } catch (error) {
    // Clean up temp file if rename failed
    try {
      await fs.unlink(tempfile);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Lists snapshots for a domain, sorted by timestamp (newest first).
 */
async function listSnapshotsForDomain(domain: string): Promise<DomainSnapshot[]> {
  const domainDir = path.join(SNAPSHOTS_DIR, domain);
  
  try {
    await fs.mkdir(domainDir, { recursive: true });
    const files = await fs.readdir(domainDir);
    
    // Filter JSON files and sort by modification time (newest first)
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const snapshots: DomainSnapshot[] = [];

    for (const file of jsonFiles) {
      try {
        const filepath = path.join(domainDir, file);
        const content = await fs.readFile(filepath, "utf-8");
        const snapshot = JSON.parse(content) as DomainSnapshot;
        snapshots.push(snapshot);
      } catch (error) {
        console.error(`Error reading snapshot file ${file}:`, error);
      }
    }

    // Sort by timestamp, newest first
    snapshots.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    return snapshots;
  } catch (error) {
    console.error(`Error listing snapshots for ${domain}:`, error);
    return [];
  }
}

/**
 * Enforces snapshot retention policy: keeps only the configured number of most recent snapshots.
 * Deletes older snapshots first if count exceeds the maximum.
 */
async function enforceSnapshotRetention(domain: string): Promise<void> {
  const domainDir = path.join(SNAPSHOTS_DIR, domain);
  
  try {
    const files = await fs.readdir(domainDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

    // If too many snapshots exist, delete oldest first
    if (jsonFiles.length > MAX_SNAPSHOTS_PER_DOMAIN) {
      const filesToDelete = jsonFiles.slice(0, jsonFiles.length - MAX_SNAPSHOTS_PER_DOMAIN);
      
      for (const file of filesToDelete) {
        const filepath = path.join(domainDir, file);
        await fs.unlink(filepath);
      }
    }
  } catch (error) {
    console.error(`Error enforcing retention for ${domain}:`, error);
  }
}

/**
 * Persists a snapshot: writes to disk, enforces retention, and updates store.
 * Returns the filepath of the written snapshot.
 */
export async function persistSnapshot(domain: string, snapshot: DomainSnapshot): Promise<string> {
  const validatedSnapshot = validateSnapshot(snapshot);

  // Write the full blob to disk with atomic rename. Snapshot files are large
  // append-mostly artifacts — they stay on the filesystem; only the
  // last-snapshot cache lives in SQLite for fast dashboard reads.
  const filepath = await atomicWriteSnapshot(domain, validatedSnapshot);

  await enforceSnapshotRetention(domain);

  // Refresh the SQLite last-snapshot cache. If the domain row does not yet
  // exist (someone called persistSnapshot for an unregistered domain — only
  // the migration script and tests do this), mint an ownership record so the
  // row is fully populated.
  const db = getDb();
  const existing = fetchRow(domain);
  if (existing) {
    db.prepare(
      `UPDATE domains
       SET last_snapshot_json = ?, updated_at = datetime('now')
       WHERE name = ?`,
    ).run(JSON.stringify(validatedSnapshot), domain);
  } else {
    const ownership = createOwnershipRecord();
    db.prepare(
      `INSERT INTO domains (
         name, last_snapshot_json,
         ownership_token, ownership_state,
         ownership_verified_at, ownership_failed_at, ownership_consecutive_failures
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      domain,
      JSON.stringify(validatedSnapshot),
      ownership.token,
      ownership.state,
      ownership.verifiedAt,
      ownership.failedAt,
      ownership.consecutiveFailures,
    );
  }

  return filepath;
}

/**
 * Gets the most recent snapshot for a domain from disk.
 * Falls back to legacy store if not found in filesystem.
 */
export async function getLatestSnapshot(domain: string): Promise<DomainSnapshot | null> {
  const snapshots = await listSnapshotsForDomain(domain);
  
  if (snapshots.length > 0) {
    return snapshots[0]; // Already sorted newest first
  }
  
  // Fallback to legacy store
  return getDomainSnapshot(domain);
}

/**
 * Gets all snapshots for a domain (up to the retention limit), newest first.
 */
export async function getSnapshotHistory(domain: string): Promise<DomainSnapshot[]> {
  return listSnapshotsForDomain(domain);
}

// ============================================================================
// v0.1.2 Deterministic Diff Engine
// ============================================================================

export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

/**
 * Recursively compares two objects and returns a flat list of changes.
 * Ignores the 'timestamp' field.
 * Sorts object keys before comparing for deterministic output.
 * Normalizes arrays before comparing (by value, not index).
 */
function createDiff(
  previous: unknown,
  latest: unknown,
  prefix = "",
  ignoreFields = new Set(["timestamp"])
): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  // Handle null/undefined
  if (previous === null || previous === undefined || latest === null || latest === undefined) {
    if (previous !== latest) {
      diffs.push({ path: prefix || "root", from: previous, to: latest });
    }
    return diffs;
  }

  // Handle arrays: normalize and compare by value
  if (Array.isArray(previous) && Array.isArray(latest)) {
    const prevSorted = JSON.parse(JSON.stringify(previous)).sort((a: unknown, b: unknown) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    );
    const latestSorted = JSON.parse(JSON.stringify(latest)).sort((a: unknown, b: unknown) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    );

    // Compare sorted arrays
    if (JSON.stringify(prevSorted) !== JSON.stringify(latestSorted)) {
      diffs.push({ path: prefix, from: prevSorted, to: latestSorted });
    }
    return diffs;
  }

  // Handle objects: sort keys before comparing
  if (typeof previous === "object" && typeof latest === "object") {
    const prevKeys = Object.keys(previous as Record<string, unknown>).sort();
    const latestKeys = Object.keys(latest as Record<string, unknown>).sort();

    // Get union of all keys
    const allKeys = new Set([...prevKeys, ...latestKeys]);

    for (const key of Array.from(allKeys).sort()) {
      // Skip ignored fields
      if (ignoreFields.has(key)) {
        continue;
      }

      const prevVal = (previous as Record<string, unknown>)[key];
      const latestVal = (latest as Record<string, unknown>)[key];

      const newPrefix = prefix ? `${prefix}.${key}` : key;

      // Recursively compare nested structures
      if (typeof prevVal === "object" && typeof latestVal === "object") {
        diffs.push(...createDiff(prevVal, latestVal, newPrefix, ignoreFields));
      } else if (prevVal !== latestVal) {
        diffs.push({ path: newPrefix, from: prevVal, to: latestVal });
      }
    }

    return diffs;
  }

  // Handle primitives
  if (previous !== latest) {
    diffs.push({ path: prefix, from: previous, to: latest });
  }

  return diffs;
}

/**
 * Computes the deterministic diff between latest and previous snapshots for a domain.
 * Returns empty array if fewer than 2 snapshots exist.
 * Output is sorted by path (deterministic).
 */
export async function getDomainDiff(domain: string): Promise<DiffEntry[]> {
  const snapshots = await getSnapshotHistory(domain);

  // Need at least 2 snapshots to compute a diff
  if (snapshots.length < 2) {
    return [];
  }

  // snapshots are sorted newest first, so:
  // snapshots[0] = latest
  // snapshots[1] = previous
  const latest = snapshots[0];
  const previous = snapshots[1];

  const diffs = createDiff(previous, latest);

  // Sort by path for deterministic output
  diffs.sort((a, b) => a.path.localeCompare(b.path));

  return diffs;
}

// ============================================================================
// v0.1.3 Stability Classification Engine
// ============================================================================

export interface StatusSignal {
  rule: string;
  severity: "stable" | "drift" | "risk" | "critical";
  path?: string;
  days_remaining?: number;
}

/**
 * Domain state vs stability state are orthogonal.
 * domain_state: whether the domain can be resolved/is registered
 * stability_state: only applies when domain_state = "valid"
 */
export interface StatusResult {
  domain_state: "invalid" | "valid";
  stability_state?: "baseline" | "stable" | "drift" | "risk" | "critical";
  signals?: StatusSignal[];
}

// ============================================================================
// v0.1.4 Custom Classification Ruleset System
// ============================================================================

/**
 * Rule override configuration for a specific classification rule.
 * Allows enabling/disabling rules and overriding severity thresholds.
 */
export interface RuleOverride {
  enabled?: boolean;
  severity?: "stable" | "drift" | "risk"; // Override the default severity
  threshold?: number; // Days threshold for expiration warnings
}

/**
 * Custom classification ruleset loaded from ruleset.local.json.
 * All fields optional; defaults apply if not specified.
 */
export interface CustomRuleset {
  metadata?: {
    name?: string;
    description?: string;
    createdAt?: string;
  };
  rules?: {
    registrar_change?: RuleOverride;
    nameserver_change?: RuleOverride;
    mx_change?: RuleOverride;
    spf_removed?: RuleOverride;
    dmarc_removed?: RuleOverride;
    asn_change?: RuleOverride;
    tls_expiration_changed?: RuleOverride;
    soa_serial_change?: RuleOverride;
  };
}

/**
 * Internal representation of merged and validated rules.
 * All rules present with effective settings.
 */
interface EffectiveRules {
  [key: string]: {
    enabled: boolean;
    severity: "stable" | "drift" | "risk";
    threshold?: number;
  };
}

// ============================================================================
// v0.1.9_PATCH Domain Validity Detection
// ============================================================================

/**
 * Checks if a domain is valid (resolvable and registered).
 * Returns false if:
 * - DNS resolution fails with ENOTFOUND/NXDOMAIN
 * - RDAP lookup returns no registration
 * - Domain has invalid TLD
 * Returns true if at least one source (RDAP, DNS A/AAAA, TLS) succeeds
 */
export async function isValidDomain(domain: string): Promise<boolean> {
  // Basic format check: must contain at least one dot and valid characters
  if (!domain || !domain.includes(".") || !/^[a-z0-9.-]+$/i.test(domain)) {
    return false;
  }

  try {
    // Try DNS resolution (A record)
    try {
      const aRecords = await dns.resolve4(domain).catch(() => []);
      if (aRecords.length > 0) {
        return true; // Domain has A records
      }
    } catch {
      // Fall through
    }

    // Try RDAP lookup
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`https://rdap.org/domain/${domain}`, {
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timeoutId);

      if (response && response.ok) {
        return true; // RDAP found registration
      }
    } catch {
      // Fall through
    }

    // Try TLS connection
    try {
      const certificate = await new Promise<boolean>((resolve) => {
        const socket = tls.connect(
          443,
          domain,
          { servername: domain },
          function () {
            socket.destroy();
            resolve(true);
          }
        );
        socket.on("error", () => resolve(false));
        socket.setTimeout(5000, () => {
          socket.destroy();
          resolve(false);
        });
      });
      if (certificate) {
        return true; // TLS succeeded
      }
    } catch {
      // Fall through
    }

    // All methods failed - domain is invalid
    return false;
  } catch (error) {
    console.error(`Domain validity check error for ${domain}:`, error);
    return false; // Conservative: treat errors as invalid
  }
}

/**
 * Loads custom ruleset from ruleset.local.json if present.
 * Returns null if file doesn't exist or is invalid.
 */
async function loadCustomRuleset(): Promise<CustomRuleset | null> {
  try {
    const rulesetPath = path.join(process.cwd(), "ruleset.local.json");
    const content = await fs.readFile(rulesetPath, "utf-8");
    const parsed = JSON.parse(content) as CustomRuleset;
    return parsed;
  } catch (_error) {
    // File doesn't exist or is invalid JSON - silently return null
    // This is expected behavior for optional ruleset
    return null;
  }
}

/**
 * Validates custom ruleset structure.
 * Returns true if valid, false otherwise.
 */
function validateRuleset(ruleset: CustomRuleset): boolean {
  if (!ruleset || typeof ruleset !== "object") {
    return false;
  }

  // Validate rules object if present
  if (ruleset.rules && typeof ruleset.rules === "object") {
    for (const [_key, override] of Object.entries(ruleset.rules)) {
      if (!override || typeof override !== "object") {
        return false;
      }

      // Validate override contents
      if (override.enabled !== undefined && typeof override.enabled !== "boolean") {
        return false;
      }
      if (override.severity && !["stable", "drift", "risk"].includes(override.severity)) {
        return false;
      }
      if (override.threshold !== undefined && typeof override.threshold !== "number") {
        return false;
      }
    }
  }

  return true;
}

/**
 * Merges custom ruleset with internal defaults to create effective rules.
 * Custom ruleset overrides take precedence over defaults.
 */
function mergeRuleset(custom: CustomRuleset | null): EffectiveRules {
  // Default rules configuration
  const defaults: EffectiveRules = {
    registrar_change: { enabled: true, severity: "risk" },
    nameserver_change: { enabled: true, severity: "risk" },
    mx_change: { enabled: true, severity: "risk" },
    spf_removed: { enabled: true, severity: "risk" },
    dmarc_removed: { enabled: true, severity: "risk" },
    asn_change: { enabled: true, severity: "risk" },
    tls_expiration_changed: { enabled: true, severity: "drift" },
    soa_serial_change: { enabled: true, severity: "drift" },
  };

  // If no custom ruleset, return defaults
  if (!custom || !custom.rules) {
    return defaults;
  }

  // Merge custom overrides with defaults
  const effective = { ...defaults };

  for (const [ruleName, override] of Object.entries(custom.rules)) {
    if (override && ruleName in effective) {
      const existing = effective[ruleName];

      // Apply overrides
      if (override.enabled !== undefined) {
        existing.enabled = override.enabled;
      }
      if (override.severity !== undefined) {
        existing.severity = override.severity;
      }
      if (override.threshold !== undefined) {
        existing.threshold = override.threshold;
      }
    }
  }

  return effective;
}

// ============================================================================
// v0.1.5 Expiration Warning System
// ============================================================================

/**
 * Parses ISO 8601 date string to UTC milliseconds.
 * Returns 0 if date is invalid (safe fallback).
 */
function parseUTCDate(dateStr: string): number {
  if (!dateStr) return 0;
  try {
    return new Date(dateStr).getTime();
  } catch {
    return 0;
  }
}

/**
 * Calculates days remaining until expiration.
 * Formula: floor((expiry_utc - now_utc) / 86400000)
 * Returns negative number if already expired.
 */
function daysRemaining(expiryUTC: number): number {
  const nowUTC = Date.now();
  const msRemaining = expiryUTC - nowUTC;
  return Math.floor(msRemaining / 86400000);
}

/**
 * Evaluates TLS certificate expiration from snapshot.
 * Returns array of expiration signals (critical/risk/drift).
 */
function evaluateTLSExpiration(snapshot: DomainSnapshot): StatusSignal[] {
  const signals: StatusSignal[] = [];

  if (!snapshot.sslExpires) {
    return signals; // No TLS data available
  }

  const expiryUTC = parseUTCDate(snapshot.sslExpires);
  if (expiryUTC === 0) {
    return signals; // Invalid date
  }

  const days = daysRemaining(expiryUTC);

  if (days <= 0) {
    signals.push({
      rule: "tls_certificate_expired",
      path: "sslExpires",
      severity: "critical",
      days_remaining: days,
    });
  } else if (days <= 7) {
    signals.push({
      rule: "tls_certificate_expiring_soon",
      path: "sslExpires",
      severity: "risk",
      days_remaining: days,
    });
  } else if (days <= 14) {
    signals.push({
      rule: "tls_certificate_expiration_warning",
      path: "sslExpires",
      severity: "drift",
      days_remaining: days,
    });
  }

  return signals;
}

/**
 * Evaluates domain registration expiration from snapshot.
 * Returns array of expiration signals (critical/risk/drift).
 */
function evaluateDomainExpiration(snapshot: DomainSnapshot): StatusSignal[] {
  const signals: StatusSignal[] = [];

  if (!snapshot.expires) {
    return signals; // No expiration data available
  }

  const expiryUTC = parseUTCDate(snapshot.expires);
  if (expiryUTC === 0) {
    return signals; // Invalid date
  }

  const days = daysRemaining(expiryUTC);

  if (days <= 0) {
    signals.push({
      rule: "domain_registration_expired",
      path: "expires",
      severity: "critical",
      days_remaining: days,
    });
  } else if (days <= 14) {
    signals.push({
      rule: "domain_registration_expiring_soon",
      path: "expires",
      severity: "risk",
      days_remaining: days,
    });
  } else if (days <= 30) {
    signals.push({
      rule: "domain_registration_expiration_warning",
      path: "expires",
      severity: "drift",
      days_remaining: days,
    });
  }

  return signals;
}

/**
 * Applies deterministic classification rules to a list of diffs.
 * Returns status and list of triggered signals.
 *
 * Rules can be customized via ruleset.local.json:
 * - Enable/disable specific rules
 * - Override severity (risk/drift/stable)
 * - Set expiration warning thresholds
 *
 * Priority: risk > drift > stable (applied to effective rules)
 */
export async function applyClassificationRules(
  diffs: DiffEntry[],
  snapshot?: DomainSnapshot,
  isFirstSnapshot: boolean = false
): Promise<StatusResult> {
  const signals: StatusSignal[] = [];
  const statusSeverities: { [status: string]: number } = {
    stable: 0,
    drift: 1,
    risk: 2,
    critical: 3,
  };

  // First snapshot (baseline) - no diff evaluation yet
  if (isFirstSnapshot) {
    return {
      domain_state: "valid",
      stability_state: "baseline",
      signals: [],
    };
  }

  // No diffs and not first snapshot means stable
  if (diffs.length === 0 && !snapshot) {
    return {
      domain_state: "valid",
      stability_state: "stable",
      signals: [{ rule: "no_changes_detected", severity: "stable", path: "" }],
    };
  }

  // Load and merge ruleset
  let customRuleset: CustomRuleset | null = null;
  try {
    customRuleset = await loadCustomRuleset();
    if (customRuleset && !validateRuleset(customRuleset)) {
      console.warn("Invalid custom ruleset, falling back to defaults");
      customRuleset = null;
    }
  } catch (error) {
    console.error("Error loading custom ruleset:", error);
    // Continue with defaults
  }

  const effectiveRules = mergeRuleset(customRuleset);

  // Evaluate each diff against rules
  for (const diff of diffs) {
    const path = diff.path.toLowerCase();

    // Check registrar_change rule
    if (path === "registrar" && effectiveRules.registrar_change.enabled) {
      signals.push({ rule: "registrar_change", severity: effectiveRules.registrar_change.severity, path: diff.path });
    }
    // Check nameserver_change rule
    else if (path === "nameservers" && effectiveRules.nameserver_change.enabled) {
      signals.push({ rule: "nameserver_change", severity: effectiveRules.nameserver_change.severity, path: diff.path });
    }
    // Check mx_change rule
    else if (path === "mxrecords" && effectiveRules.mx_change.enabled) {
      signals.push({ rule: "mx_change", severity: effectiveRules.mx_change.severity, path: diff.path });
    }
    // Check spf_removed rule
    else if (path === "spfrecord" && effectiveRules.spf_removed.enabled) {
      if (diff.from && !diff.to) {
        signals.push({ rule: "spf_removed", severity: effectiveRules.spf_removed.severity, path: diff.path });
      }
    }
    // Check dmarc_removed rule
    else if (path === "dmarcrecord" && effectiveRules.dmarc_removed.enabled) {
      if (diff.from && !diff.to) {
        signals.push({ rule: "dmarc_removed", severity: effectiveRules.dmarc_removed.severity, path: diff.path });
      }
    }
    // Check asn_change rule
    else if (path === "asn" && effectiveRules.asn_change.enabled) {
      signals.push({ rule: "asn_change", severity: effectiveRules.asn_change.severity, path: diff.path });
    }
    // Check tls_expiration_changed rule
    else if (path === "sslexpires" && effectiveRules.tls_expiration_changed.enabled) {
      signals.push({ rule: "tls_expiration_changed", severity: effectiveRules.tls_expiration_changed.severity, path: diff.path });
    }
    // Check soa_serial_change rule
    else if (path === "soa.serial" && effectiveRules.soa_serial_change.enabled) {
      signals.push({ rule: "soa_serial_change", severity: effectiveRules.soa_serial_change.severity, path: diff.path });
    }
  }

  // Evaluate expiration signals if snapshot provided
  if (snapshot) {
    const tlsExpirationSignals = evaluateTLSExpiration(snapshot);
    signals.push(...tlsExpirationSignals);

    const domainExpirationSignals = evaluateDomainExpiration(snapshot);
    signals.push(...domainExpirationSignals);
  }

  const maxSeverity = signals.reduce((max, signal) => {
    return Math.max(max, statusSeverities[signal.severity]);
  }, statusSeverities.stable);

  // Determine final stability_state based on max severity
  const stabilityMap = ["stable", "drift", "risk", "critical"];
  const stability_state = (stabilityMap[maxSeverity] || "stable") as "stable" | "drift" | "risk" | "critical";

  return {
    domain_state: "valid",
    stability_state,
    signals,
  };
}

/**
 * Gets the domain state and stability status for a domain.
 * Returns domain_state: invalid if domain cannot be resolved.
 * Returns domain_state: valid with stability_state: baseline if only 1 snapshot.
 * Returns domain_state: valid with stability_state: (stable|drift|risk|critical) if 2+ snapshots.
 */
export async function getDomainStatus(domain: string): Promise<StatusResult> {
  try {
    // Check if domain is valid first
    const valid = await isValidDomain(domain);
    if (!valid) {
      return {
        domain_state: "invalid",
      };
    }

    // Domain is valid - check snapshot count
    const snapshots = await getSnapshotHistory(domain);
    const isFirstSnapshot = snapshots.length === 1;

    const diffs = await getDomainDiff(domain);
    const latestSnapshot = await getLatestSnapshot(domain);
    return applyClassificationRules(diffs, latestSnapshot || undefined, isFirstSnapshot);
  } catch (error) {
    console.error(`Error computing status for ${domain}:`, error);
    // Return invalid on error (conservative)
    return {
      domain_state: "invalid",
    };
  }
}

// ============================================================================
// Licensing — domain capacity enforcement
// ============================================================================

export interface DomainAccess {
  /** Resolved license status driving the capacity. */
  license: LicenseStatus;
  /** Effective number of domains that may be actively monitored. */
  limit: number;
  /** Domains within the limit — fully active. */
  active: string[];
  /** Domains beyond the limit — frozen until capacity is restored. */
  frozen: string[];
}

/**
 * Resolves domain capacity from the current license and the store.
 *
 * Domains keep their insertion order in the store (earliest-added first), so
 * the first `limit` are active and any beyond that are frozen. Frozen domains
 * are never deleted — they are simply not (re)snapshotted until capacity is
 * restored by a valid license.
 */
export async function getDomainAccess(): Promise<DomainAccess> {
  const license = getLicenseStatus();
  const limit = license.domainLimit;
  const domains = await getDomains();
  return {
    license,
    limit,
    active: domains.slice(0, limit),
    frozen: domains.slice(limit),
  };
}

/**
 * Determines whether a snapshot may be created for `domain` under the current
 * license: an existing active domain is allowed; an existing frozen domain is
 * denied; a new domain is allowed only when there is free capacity.
 */
export async function canSnapshotDomain(
  domain: string,
): Promise<{ allowed: boolean; reason: string }> {
  const access = await getDomainAccess();

  if (access.frozen.includes(domain)) {
    return {
      allowed: false,
      reason: `Domain is frozen — beyond the licensed limit of ${access.limit}. ${access.license.reason}`,
    };
  }
  if (access.active.includes(domain)) {
    return { allowed: true, reason: "Domain is within the licensed limit." };
  }

  const total = access.active.length + access.frozen.length;
  if (total >= access.limit) {
    return {
      allowed: false,
      reason: `Domain limit reached (${access.limit}). ${access.license.reason}`,
    };
  }
  return { allowed: true, reason: "Within the licensed limit." };
}

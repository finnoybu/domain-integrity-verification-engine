/**
 * Smoke test for settings + scheduling (PR 6, slice 1):
 *   - v3 → v4 schema migration adds settings, domain_settings, and
 *     domains.last_check_at.
 *   - Effective resolution chain: per-domain → DB global → env → default.
 *   - Validation rejects out-of-range / non-integer values.
 *   - last_check_at round-trips on storage.
 *   - nextCheckAtForDomain + isDue compose for the scheduler.
 *
 * Runs against an isolated DB via DIVE_DATA_DIR. Exits 0 on pass, 1 on any
 * failure.
 */

import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dive-settings-smoke-"));
process.env.DIVE_DATA_DIR = TMP;

// Clear any inherited env so the default-fallback test is deterministic.
delete process.env.MONITOR_INTERVAL;
delete process.env.SNAPSHOT_RETENTION;
delete process.env.OWNERSHIP_LOOKUP_TIMEOUT_MS;

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
  const settings = await import("../src/lib/settings");
  const storage = await import("../src/lib/storage");

  const db = getDb();

  // --- v4 schema ------------------------------------------------------
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('settings','domain_settings')",
    )
    .all()
    .map((r) => r.name)
    .sort();
  check("v4 tables created", JSON.stringify(tables) === JSON.stringify(["domain_settings", "settings"]));

  const columns = db
    .prepare<[], { name: string }>("PRAGMA table_info(domains)")
    .all()
    .map((r) => r.name);
  check("domains.last_check_at column added", columns.includes("last_check_at"));

  const version = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string };
  check("schema version stamped to 4", version.value === "4");

  // --- effective resolution: default (no DB, no env) ------------------
  const defInterval = await settings.getGlobalSetting("monitor_interval_seconds");
  check("default interval = 3600", defInterval === 3600);

  // --- env layer ------------------------------------------------------
  process.env.MONITOR_INTERVAL = "120";
  const envInterval = await settings.getGlobalSetting("monitor_interval_seconds");
  check("env override picked up (120)", envInterval === 120);

  // Invalid env (below min) falls back to default.
  process.env.MONITOR_INTERVAL = "1";
  check("env below min → default", (await settings.getGlobalSetting("monitor_interval_seconds")) === 3600);
  process.env.MONITOR_INTERVAL = "120";

  // --- DB layer overrides env -----------------------------------------
  await settings.setGlobalSetting("monitor_interval_seconds", 300);
  check("DB overrides env (300 wins over 120)", (await settings.getGlobalSetting("monitor_interval_seconds")) === 300);

  // --- validation: reject out-of-range --------------------------------
  let threw = false;
  try {
    await settings.setGlobalSetting("monitor_interval_seconds", 5);
  } catch {
    threw = true;
  }
  check("setGlobalSetting rejects below min", threw);

  threw = false;
  try {
    await settings.setGlobalSetting("monitor_interval_seconds", 99999999);
  } catch {
    threw = true;
  }
  check("setGlobalSetting rejects above max", threw);

  // --- clearGlobalSetting falls back to env ---------------------------
  await settings.clearGlobalSetting("monitor_interval_seconds");
  check("clearGlobalSetting → env (120) again", (await settings.getGlobalSetting("monitor_interval_seconds")) === 120);

  // --- per-domain override beats global -------------------------------
  // Add a domain row so it can carry settings (FK isn't enforced on
  // domain_settings, but the API will only ever set for known domains).
  db.prepare(
    `INSERT INTO domains (name, last_snapshot_json, ownership_token, ownership_state)
     VALUES (?, '{}', 'tok', 'ownership_verified')`,
  ).run("d1.test");

  await settings.setDomainSetting("d1.test", "monitor_interval_seconds", 60);
  check("per-domain override wins", (await settings.effectiveMonitorIntervalSeconds("d1.test")) === 60);

  // A different domain still sees the global / env.
  check("other domain still sees global/env", (await settings.effectiveMonitorIntervalSeconds("d2.test")) === 120);

  // listGlobalSettings reports provenance.
  const view = await settings.listGlobalSettings();
  const intervalView = view.find((v) => v.key === "monitor_interval_seconds");
  check("listGlobalSettings reports source='env' after clear", intervalView?.source === "env" && intervalView.effective === 120);

  await settings.setGlobalSetting("monitor_interval_seconds", 600);
  const view2 = await settings.listGlobalSettings();
  check("listGlobalSettings reports source='db' after set", view2.find((v) => v.key === "monitor_interval_seconds")?.source === "db");

  // --- per-domain clear → inherits global -----------------------------
  await settings.clearDomainSetting("d1.test", "monitor_interval_seconds");
  check("clearDomainSetting → effective inherits global (600)", (await settings.effectiveMonitorIntervalSeconds("d1.test")) === 600);

  // --- last_check_at round-trip --------------------------------------
  check("getLastCheckAt initially null", (await storage.getLastCheckAt("d1.test")) === null);
  const stamp = "2026-05-28T10:00:00.000Z";
  await storage.setLastCheckAt("d1.test", stamp);
  check("setLastCheckAt round-trips", (await storage.getLastCheckAt("d1.test")) === stamp);

  // --- nextCheckAtForDomain + isDue -----------------------------------
  // d1.test is on 600s interval; last check 10:00:00 → next 10:10:00.
  const next = await settings.nextCheckAtForDomain("d1.test", stamp);
  check("nextCheckAtForDomain = last + interval", next?.toISOString() === "2026-05-28T10:10:00.000Z");
  check("isDue is true when now is past next", settings.isDue(next, new Date("2026-05-28T10:11:00Z")));
  check("isDue is false when now is before next", !settings.isDue(next, new Date("2026-05-28T10:05:00Z")));
  check("isDue is true when nextCheck is null (never checked)", settings.isDue(null));

  closeDb();
}

main()
  .catch((err) => {
    console.error("smoke-settings fatal:", err);
    failures.push("fatal: " + (err instanceof Error ? err.message : String(err)));
  })
  .finally(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (failures.length > 0) {
      console.error(`\n✗ smoke-settings: ${failures.length} failure(s)`);
      process.exit(1);
    }
    console.log("\n✓ smoke-settings: all checks passed");
    process.exit(0);
  });

/**
 * Smoke test for the persisted alert configuration (PR 5, slice 1):
 *   - v2 → v3 schema migration adds alert_channels + alert_routes.
 *   - First-run import of alerts.local.json maps channels → channel rows
 *     and the global severities → a default (scope='all') route per channel,
 *     then archives the JSON file.
 *   - Channel/route CRUD round-trips; deleting a channel cascades its routes.
 *   - Override resolution: per-domain routes fully replace the defaults for
 *     that domain; domains without per-domain routes see the defaults.
 *
 * Runs against an isolated DB+cwd via DIVE_DATA_DIR and process.chdir() so it
 * never touches production data/dive.db or the repo's alerts.local.json.
 *
 * Run: `npx tsx scripts/smoke-alerts.ts`  (exits 0 on pass, 1 on any failure)
 */

import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dive-alerts-smoke-"));
const TMP_CWD = path.join(TMP, "cwd");
const TMP_DATA = path.join(TMP, "data");
fs.mkdirSync(TMP_CWD, { recursive: true });
fs.mkdirSync(TMP_DATA, { recursive: true });

// Drop a sample alerts.local.json into the temp cwd BEFORE switching cwd, then
// switch — the import looks at process.cwd().
fs.writeFileSync(
  path.join(TMP_CWD, "alerts.local.json"),
  JSON.stringify({
    channels: {
      email: {
        enabled: true,
        from: "alerts@example.test",
        to: ["ops@example.test", "security@example.test"],
      },
      webhook: {
        enabled: false,
        url: "https://hooks.example.test/x",
        method: "POST",
        headers: { "X-Test": "1" },
      },
    },
    severities: { info: false, warning: true, critical: true },
  }),
);

const ORIGINAL_CWD = process.cwd();
process.chdir(TMP_CWD);
process.env.DIVE_DATA_DIR = TMP_DATA;

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
  const cfg = await import("../src/lib/alert-config");

  // Trigger migration + import.
  const db = getDb();

  // --- v3 schema -------------------------------------------------------
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('alert_channels','alert_routes')",
    )
    .all()
    .map((r) => r.name)
    .sort();
  check("v3 tables created", JSON.stringify(tables) === JSON.stringify(["alert_channels", "alert_routes"]));

  const version = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string };
  // v3 introduced these tables; later versions still run through. Assert "≥ 3"
  // so this smoke survives future migration ladder additions.
  check("schema version ≥ 3", Number(version.value) >= 3);

  // --- alerts.local.json import ----------------------------------------
  const channels = await cfg.listChannels();
  check("imported 2 channels", channels.length === 2);
  const smtp = channels.find((c) => c.type === "smtp");
  const webhook = channels.find((c) => c.type === "webhook");
  check("smtp channel name + config + enabled",
    smtp?.name === "Email (imported)" &&
    (smtp?.config as { from: string }).from === "alerts@example.test" &&
    smtp?.enabled === true,
  );
  check("webhook channel name + url + disabled honored",
    webhook?.name === "Webhook (imported)" &&
    (webhook?.config as { url: string }).url === "https://hooks.example.test/x" &&
    webhook?.enabled === false,
  );

  const routes = await cfg.listRoutes();
  check("imported 1 default route per channel", routes.length === 2);
  check("all imported routes are 'all' scope",
    routes.every((r) => r.scopeType === "all" && r.scopeValue === null),
  );
  check("imported severities ⊆ {warning,critical} per source",
    routes.every((r) => JSON.stringify(r.severities) === JSON.stringify(["warning","critical"])),
  );

  // --- archive ---------------------------------------------------------
  check("alerts.local.json archived",
    !fs.existsSync(path.join(TMP_CWD, "alerts.local.json")) &&
    fs.existsSync(path.join(TMP_CWD, "alerts.local.json.imported")),
  );

  // Idempotent: re-open with the archive in place must not re-import.
  closeDb();
  getDb();
  check("import idempotent across reopen",
    (await cfg.listChannels()).length === 2,
  );

  // --- channel CRUD ----------------------------------------------------
  const newChan = await cfg.createChannel({
    type: "smtp",
    name: "Security inbox",
    config: { from: "alerts@example.test", to: ["sec@example.test"] },
    enabled: true,
  });
  check("createChannel returns id + parsed config",
    newChan.id > 0 && (newChan.config as { from: string }).from === "alerts@example.test",
  );

  const updated = await cfg.updateChannel(newChan.id, { enabled: false, name: "Security (muted)" });
  const refetched = await cfg.getChannel(newChan.id);
  check("updateChannel mutates enabled + name",
    updated && refetched?.enabled === false && refetched?.name === "Security (muted)",
  );

  // Attach a route to it then delete the channel — route should cascade.
  await cfg.createRoute({
    scopeType: "all",
    scopeValue: null,
    channelId: newChan.id,
    severities: ["critical"],
  });
  const beforeDelete = await cfg.listRoutes();
  await cfg.deleteChannel(newChan.id);
  const afterDelete = await cfg.listRoutes();
  check("deleteChannel cascades routes",
    beforeDelete.length === afterDelete.length + 1,
  );

  // --- route creation guards ------------------------------------------
  let createThrew = false;
  try {
    await cfg.createRoute({
      scopeType: "domain",
      scopeValue: null,
      channelId: smtp!.id,
      severities: ["warning"],
    });
  } catch {
    createThrew = true;
  }
  check("createRoute('domain') without scopeValue throws", createThrew);

  let emptySevThrew = false;
  try {
    await cfg.createRoute({
      scopeType: "all",
      scopeValue: null,
      channelId: smtp!.id,
      severities: [],
    });
  } catch {
    emptySevThrew = true;
  }
  check("createRoute with empty severities throws", emptySevThrew);

  // --- override resolution --------------------------------------------
  // Defaults currently: one 'all' route per imported channel (smtp + webhook).
  // Add a per-domain route for 'override.test' pointing only at the smtp channel.
  await cfg.createRoute({
    scopeType: "domain",
    scopeValue: "override.test",
    channelId: smtp!.id,
    severities: ["warning", "critical"],
  });
  const allRoutes = await cfg.listRoutes();

  const effForOverride = cfg.effectiveRoutesForDomain("override.test", allRoutes);
  check("override.test → exactly 1 per-domain route (defaults replaced)",
    effForOverride.length === 1 &&
    effForOverride[0].scopeType === "domain" &&
    effForOverride[0].channelId === smtp!.id,
  );

  const effForOther = cfg.effectiveRoutesForDomain("default.test", allRoutes);
  check("default.test → 2 default routes (no per-domain present)",
    effForOther.length === 2 &&
    effForOther.every((r) => r.scopeType === "all"),
  );

  // --- engine: dispatchPlanForDomain (override × severity × enabled) -----
  const eng = await import("../src/lib/alerting");
  const channelsAfter = await cfg.listChannels();
  const routesAfter = await cfg.listRoutes();
  const smtpFinal = channelsAfter.find((c) => c.type === "smtp")!;
  const webhookFinal = channelsAfter.find((c) => c.type === "webhook")!;

  const ts = new Date().toISOString();
  const warningEvent = {
    domain: "default.test",
    kind: "stability_transition" as const,
    severity: "warning" as const,
    from: "stable",
    to: "drift",
    message: "x",
    timestamp: ts,
  };
  const criticalEvent = { ...warningEvent, severity: "critical" as const, to: "risk" };

  // default.test: 2 default routes ('all') — smtp enabled, webhook disabled.
  // Both routes carry ["warning","critical"]. So the warning event should be
  // queued only to the SMTP channel (the webhook channel is disabled).
  const planDefault = eng.dispatchPlanForDomain(
    "default.test",
    [warningEvent],
    { channels: channelsAfter, routes: routesAfter },
  );
  check("default-route dispatch skips the disabled channel",
    planDefault.size === 1 &&
    planDefault.has(smtpFinal.id) &&
    !planDefault.has(webhookFinal.id),
  );

  // override.test: per-domain route → smtp only, severities ["warning","critical"]
  const planOverride = eng.dispatchPlanForDomain(
    "override.test",
    [warningEvent, criticalEvent],
    { channels: channelsAfter, routes: routesAfter },
  );
  check("override route receives both severities to its channel",
    planOverride.size === 1 &&
    planOverride.get(smtpFinal.id)?.length === 2,
  );

  // Add a per-domain route on a NEW channel that only forwards 'critical'.
  const criticalOnlyChannel = await cfg.createChannel({
    type: "smtp",
    name: "Pager",
    config: { from: "pager@example.test", to: ["oncall@example.test"] },
    enabled: true,
  });
  await cfg.createRoute({
    scopeType: "domain",
    scopeValue: "pageonly.test",
    channelId: criticalOnlyChannel.id,
    severities: ["critical"],
  });
  const channelsAfter2 = await cfg.listChannels();
  const routesAfter2 = await cfg.listRoutes();
  const planSeverity = eng.dispatchPlanForDomain(
    "pageonly.test",
    [warningEvent, criticalEvent],
    { channels: channelsAfter2, routes: routesAfter2 },
  );
  check("severity filter: 'critical'-only route drops the warning event",
    planSeverity.get(criticalOnlyChannel.id)?.length === 1 &&
    planSeverity.get(criticalOnlyChannel.id)?.[0].severity === "critical",
  );

  // Mute the channel: enabled=false → no events queued even with matching routes.
  await cfg.updateChannel(criticalOnlyChannel.id, { enabled: false });
  const channelsMuted = await cfg.listChannels();
  const planMuted = eng.dispatchPlanForDomain(
    "pageonly.test",
    [criticalEvent],
    { channels: channelsMuted, routes: routesAfter2 },
  );
  check("disabled channel produces no queued events",
    !planMuted.has(criticalOnlyChannel.id),
  );

  closeDb();
}

main()
  .catch((err) => {
    console.error("smoke-alerts fatal:", err);
    failures.push("fatal: " + (err instanceof Error ? err.message : String(err)));
  })
  .finally(() => {
    process.chdir(ORIGINAL_CWD);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (failures.length > 0) {
      console.error(`\n✗ smoke-alerts: ${failures.length} failure(s)`);
      process.exit(1);
    }
    console.log("\n✓ smoke-alerts: all checks passed");
    process.exit(0);
  });

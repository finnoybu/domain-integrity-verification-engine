/**
 * DIVE monitor worker — Monitor Phase C + Ownership Phase 3.
 *
 * A long-running Node process (run via `npm run monitor`) that ticks on a
 * configurable interval and, for each active domain:
 *
 *   1. step 0 — runs the ownership check (`recordOwnershipCheck`). A failed
 *      check increments the strike counter and the third consecutive failure
 *      flips state to `ownership_failed`. A failing tick stops here — no
 *      RDAP / DNS / TLS work runs for that domain this cycle.
 *   2. on pass — snapshots the domain (`createSnapshot` + `persistSnapshot`)
 *      and classifies it (`getDomainStatus`).
 *
 * State transitions (ownership_unverified ↔ ownership_verified ↔
 * ownership_failed, and stable / drift / risk / critical) are detected
 * against an in-memory per-domain map and logged. Alert dispatch comes in
 * Phase D — for now transitions are the seed that Phase D will read.
 *
 * Configuration is via environment variables (see docs/deployment.md):
 *   - MONITOR_INTERVAL          seconds between ticks (default 3600, min 60)
 *   - OWNERSHIP_LOOKUP_TIMEOUT_MS  TXT lookup timeout (default 5000)
 *   - SNAPSHOT_RETENTION        snapshots kept per domain (default 30)
 *
 * Shutdown: SIGINT / SIGTERM finishes the current tick, then exits cleanly.
 */

import {
  canSnapshotDomain,
  getDomainAccess,
  getDomainStatus,
  getOwnership,
  isValidDomain,
  persistSnapshot,
} from "@/lib/storage";
import { createSnapshot } from "@/lib/snapshot";
import { OWNERSHIP_FAILURE_THRESHOLD, recordOwnershipCheck } from "@/lib/ownership";

const DEFAULT_INTERVAL_SECONDS = 3600;
const MIN_INTERVAL_SECONDS = 60;

function resolveIntervalSeconds(): number {
  const configured = Number(process.env.MONITOR_INTERVAL);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(configured));
}

function ts(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${ts()}] [monitor] ${message}`);
}

function logError(message: string): void {
  console.error(`[${ts()}] [monitor] ${message}`);
}

interface PerDomainStates {
  ownership: Map<string, string>;
  stability: Map<string, string>;
}

let stopRequested = false;

function installShutdownHandlers(): void {
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopRequested) {
      // Second Ctrl-C — bail immediately.
      logError(`${signal} received again, exiting now`);
      process.exit(130);
    }
    log(`${signal} received — will exit after the current tick completes`);
    stopRequested = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

/**
 * Cooperative sleep that wakes every second so a pending shutdown signal
 * can short-circuit the wait. Returns when either the deadline elapses or
 * stopRequested flips true.
 */
function sleepUntilStoppedOrDeadline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const handle = setInterval(() => {
      if (stopRequested || Date.now() - start >= ms) {
        clearInterval(handle);
        resolve();
      }
    }, 1000);
  });
}

async function runTickForDomain(domain: string, prev: PerDomainStates): Promise<void> {
  try {
    const existing = await getOwnership(domain);
    if (!existing) {
      // Defensive: the licensed-active set comes from the store, so an
      // entry without an ownership record can only happen if state was
      // hand-edited. Skip and surface.
      logError(`${domain} has no ownership record — skip (re-add via the API)`);
      return;
    }

    // Step 0 — the unconditional proof-of-control gate.
    const check = await recordOwnershipCheck(domain);
    const ownershipState = check.ownership.state;
    const prevOwnership = prev.ownership.get(domain);
    if (prevOwnership !== ownershipState) {
      log(
        `${domain} OWNERSHIP TRANSITION ${prevOwnership ?? "(unknown)"} → ${ownershipState}`,
      );
      prev.ownership.set(domain, ownershipState);
    }

    if (!check.result.pass) {
      const reason = check.result.reason;
      log(
        `${domain} ownership=${ownershipState} (${reason}; ${check.ownership.consecutiveFailures}/${OWNERSHIP_FAILURE_THRESHOLD}) → skip`,
      );
      return;
    }

    // Step 1 — snapshot + classify.
    const valid = await isValidDomain(domain);
    const snapshot = await createSnapshot(domain);
    if (valid) {
      await persistSnapshot(domain, snapshot);
    } else {
      log(`${domain} resolved invalid — snapshot not persisted`);
    }

    const status = await getDomainStatus(domain);
    const stability = status.stability_state ?? status.domain_state;
    const prevStability = prev.stability.get(domain);
    if (prevStability !== stability) {
      log(
        `${domain} STABILITY TRANSITION ${prevStability ?? "(unknown)"} → ${stability}`,
      );
      prev.stability.set(domain, stability);
    }
    log(`${domain} ownership=verified stability=${stability}`);
  } catch (error) {
    logError(`${domain} tick error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runTick(prev: PerDomainStates): Promise<void> {
  const access = await getDomainAccess();
  log(
    `tick start — ${access.active.length} active, ${access.frozen.length} frozen (skipped), license=${access.license.tier ?? "free"}`,
  );

  for (const domain of access.active) {
    if (stopRequested) {
      log("shutdown requested mid-tick — aborting remaining domains");
      return;
    }
    // Re-check capacity per-domain so freshly-frozen domains drop out
    // immediately if the license changes during a long tick.
    const capacity = await canSnapshotDomain(domain);
    if (!capacity.allowed) {
      log(`${domain} ${capacity.reason} → skip`);
      continue;
    }
    await runTickForDomain(domain, prev);
  }

  log("tick complete");
}

async function main(): Promise<void> {
  const intervalSeconds = resolveIntervalSeconds();
  installShutdownHandlers();
  log(
    `starting — interval=${intervalSeconds}s, ownership-lookup-timeout=${process.env.OWNERSHIP_LOOKUP_TIMEOUT_MS ?? "5000"}ms, retention=${process.env.SNAPSHOT_RETENTION ?? "30"}`,
  );

  const prev: PerDomainStates = {
    ownership: new Map(),
    stability: new Map(),
  };

  while (!stopRequested) {
    await runTick(prev);
    if (stopRequested) break;
    log(`sleeping ${intervalSeconds}s`);
    await sleepUntilStoppedOrDeadline(intervalSeconds * 1000);
  }
  log("stopped");
}

main().catch((error) => {
  logError(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});

/**
 * DIVE monitor tick — single-pass entrypoint.
 *
 * Runs one monitoring pass and exits. For each licensed-active domain:
 *
 *   1. step 0 — runs the ownership check (`recordOwnershipCheck`). A failed
 *      check increments the strike counter and the third consecutive failure
 *      flips state to `ownership_failed`. A failing tick stops here — no
 *      RDAP / DNS / TLS work runs for that domain this cycle.
 *   2. on pass — snapshots the domain (`createSnapshot` + `persistSnapshot`)
 *      and classifies it (`getDomainStatus`).
 *
 * Designed to be invoked on a schedule (cron, systemd timer, Cloudflare Cron
 * Trigger, etc.) — see docs/deployment.md. The CLI entry below runs one tick
 * and exits with code 0 on completion or 1 on fatal error. State transitions
 * (ownership and stability) are derived from the persisted store, so a fresh
 * process produces accurate transition logs.
 *
 * Configuration is via environment variables:
 *   - OWNERSHIP_LOOKUP_TIMEOUT_MS  TXT lookup timeout (default 5000)
 *   - SNAPSHOT_RETENTION           snapshots kept per domain (default 30)
 *
 * (MONITOR_INTERVAL is no longer read here — the scheduler owns the cadence.
 * The dev-loop wrapper in ./index.ts reads it for local-development convenience.)
 *
 * Programmatic API: `runOneTick(): Promise<TickSummary>` — used by the
 * dev-loop wrapper and tests.
 */

import {
  canSnapshotDomain,
  getDomainAccess,
  getDomainStatus,
  getLastCheckAt,
  getOwnership,
  isValidDomain,
  persistSnapshot,
  setLastCheckAt,
} from "@/lib/storage";
import { createSnapshot } from "@/lib/snapshot";
import { OWNERSHIP_FAILURE_THRESHOLD, recordOwnershipCheck } from "@/lib/ownership";
import {
  processAlerts,
  type AlertingSet,
  type CurrentStates,
} from "@/lib/alerting";
import { loadAlertingConfig } from "@/lib/alert-config";
import { isDue, nextCheckAtForDomain } from "@/lib/settings";

export interface TickSummary {
  active: number;
  frozen: number;
  processed: number;
  /** Domains within capacity + due, but stopped by an ownership-gate failure. */
  skipped: number;
  /** Domains within capacity but their next-check time hasn't arrived yet. */
  notDue: number;
  errors: number;
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

let stopRequested = false;

/** Public for the dev-loop wrapper. */
export function isStopRequested(): boolean {
  return stopRequested;
}

/** Installable once per process; idempotent. Returns the install state. */
export function installShutdownHandlers(): void {
  if (installShutdownHandlers.installed) return;
  installShutdownHandlers.installed = true;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopRequested) {
      logError(`${signal} received again, exiting now`);
      process.exit(130);
    }
    log(`${signal} received — will exit after the current tick completes`);
    stopRequested = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
installShutdownHandlers.installed = false;

async function runTickForDomain(
  domain: string,
  alertConfig: AlertingSet,
  summary: TickSummary,
): Promise<void> {
  // Stamp last_check_at at the very end of any reached domain — success,
  // ownership-fail-skip, defensive return, or thrown error all count as
  // "we did the per-domain work this tick," so the next-due math advances.
  // Not-yet-due skips do NOT enter this function and so don't get stamped.
  try {
    // Snapshot the pre-tick state for accurate transition logging — the
    // ownership check writes to the store, so we have to read before calling
    // it.
    const priorOwnership = await getOwnership(domain);
    if (!priorOwnership) {
      // Defensive: the licensed-active set comes from the store, so an
      // entry without an ownership record can only happen if state was
      // hand-edited. Skip and surface.
      logError(`${domain} has no ownership record — skip (re-add via the API)`);
      summary.errors += 1;
      return;
    }
    const priorOwnershipState = priorOwnership.state;
    const priorStability = (await getDomainStatus(domain)).stability_state ?? null;

    // Step 0 — the unconditional proof-of-control gate.
    const check = await recordOwnershipCheck(domain);
    const ownershipState = check.ownership.state;
    if (priorOwnershipState !== ownershipState) {
      log(
        `${domain} OWNERSHIP TRANSITION ${priorOwnershipState} → ${ownershipState}`,
      );
    }

    // Build the alerting "current states" object: ownership is always
    // observed; stability only when the gate passes.
    const alertCurrent: CurrentStates = { ownershipState };

    if (!check.result.pass) {
      const reason = check.result.reason;
      log(
        `${domain} ownership=${ownershipState} (${reason}; ${check.ownership.consecutiveFailures}/${OWNERSHIP_FAILURE_THRESHOLD}) → skip`,
      );
      await dispatchAndLog(domain, alertCurrent, alertConfig);
      summary.skipped += 1;
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
    if (priorStability !== stability) {
      log(
        `${domain} STABILITY TRANSITION ${priorStability ?? "(unknown)"} → ${stability}`,
      );
    }
    log(`${domain} ownership=verified stability=${stability}`);

    alertCurrent.stabilityState = stability;
    await dispatchAndLog(domain, alertCurrent, alertConfig);
    summary.processed += 1;
  } catch (error) {
    logError(`${domain} tick error: ${error instanceof Error ? error.message : String(error)}`);
    summary.errors += 1;
  } finally {
    try {
      await setLastCheckAt(domain);
    } catch (err) {
      logError(
        `${domain} failed to record last_check_at: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function dispatchAndLog(
  domain: string,
  current: CurrentStates,
  alertConfig: AlertingSet,
): Promise<void> {
  const result = await processAlerts(domain, current, alertConfig);
  if (result.initialized) {
    log(
      `${domain} alert state initialized (stability=${current.stabilityState ?? "(unobserved)"}, ownership=${current.ownershipState ?? "(unobserved)"})`,
    );
    return;
  }
  for (const event of result.events) {
    log(
      `${domain} ALERT [${event.severity}] ${event.kind}: ${event.from ?? "(unknown)"} → ${event.to}`,
    );
  }
  if (result.dispatched > 0) {
    log(`${domain} dispatched to ${result.dispatched} channel(s)`);
  }
  for (const err of result.errors) {
    logError(`${domain} alert channel ${err.channel} failed: ${err.error}`);
  }
}

/**
 * Runs one monitoring pass across all licensed-active domains. Returns a
 * summary suitable for logging or test assertions. Honors a cooperative
 * stop request between domains so a SIGINT mid-tick exits cleanly.
 */
export async function runOneTick(): Promise<TickSummary> {
  // Load channels + routes once per tick — the dashboard mutates them between
  // ticks, but resolution per domain is cheap (in-memory filtering).
  const alertConfig = await loadAlertingConfig();
  const access = await getDomainAccess();
  const enabledChannels = alertConfig.channels.filter((c) => c.enabled).length;
  log(
    `tick start — ${access.active.length} active, ${access.frozen.length} frozen (skipped), license=${access.license.tier ?? "free"}, alerting=${enabledChannels}/${alertConfig.channels.length} channels enabled, ${alertConfig.routes.length} routes`,
  );

  const summary: TickSummary = {
    active: access.active.length,
    frozen: access.frozen.length,
    processed: 0,
    skipped: 0,
    notDue: 0,
    errors: 0,
  };

  for (const domain of access.active) {
    if (stopRequested) {
      log("shutdown requested mid-tick — aborting remaining domains");
      break;
    }
    // Re-check capacity per-domain so freshly-frozen domains drop out
    // immediately if the license changes during a long tick.
    const capacity = await canSnapshotDomain(domain);
    if (!capacity.allowed) {
      log(`${domain} ${capacity.reason} → skip`);
      summary.skipped += 1;
      continue;
    }
    // Per-domain scheduling: skip if the effective interval (per-domain
    // override → global → env → default) puts this domain in the future.
    // Not-due domains don't enter runTickForDomain, so last_check_at isn't
    // bumped — the next eligible tick picks them up.
    const last = await getLastCheckAt(domain);
    const next = await nextCheckAtForDomain(domain, last);
    if (!isDue(next)) {
      log(
        `${domain} not yet due (next ${next?.toISOString() ?? "(unknown)"}) → skip`,
      );
      summary.notDue += 1;
      continue;
    }
    await runTickForDomain(domain, alertConfig, summary);
  }

  log(
    `tick complete — processed=${summary.processed} notDue=${summary.notDue} skipped=${summary.skipped} errors=${summary.errors}`,
  );
  return summary;
}

/**
 * CLI entry — invoked when run as `tsx src/monitor/tick.ts` (npm run
 * monitor:tick). One pass, then exit. Exit code 0 on completion (regardless
 * of per-domain errors, which are logged); 1 on a fatal error setting up the
 * tick itself.
 */
async function main(): Promise<void> {
  installShutdownHandlers();
  try {
    await runOneTick();
    process.exit(0);
  } catch (error) {
    logError(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  }
}

// Only run main() when this file is the entrypoint. Allows the dev-loop
// wrapper to import runOneTick without side effects.
const isDirectInvocation =
  process.argv[1] && /[\\/]src[\\/]monitor[\\/]tick\.[cm]?ts$/.test(process.argv[1]);
if (isDirectInvocation) {
  void main();
}

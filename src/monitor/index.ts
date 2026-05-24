/**
 * DIVE monitor — dev-loop wrapper.
 *
 * Runs `runOneTick()` repeatedly with a sleep between passes, for local
 * development convenience (terminal-watching during work on monitor / alerting
 * code). Invoked via `npm run monitor`.
 *
 * **Production scheduling uses `npm run monitor:tick` under cron / systemd
 * timers / a platform scheduler** — see docs/deployment.md. This wrapper is
 * not designed for production: it loses no data on a crash (state is in the
 * store), but a long-lived process is the wrong shape for the work the
 * monitor actually does (~30 s per domain, interval measured in hours).
 *
 * Configuration:
 *   - MONITOR_INTERVAL  seconds between ticks (default 3600, min 60)
 *
 * Shutdown: SIGINT / SIGTERM finishes the current tick, then exits cleanly;
 * a second signal exits immediately.
 */

import { installShutdownHandlers, isStopRequested, runOneTick } from "./tick";

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
  console.log(`[${ts()}] [monitor:loop] ${message}`);
}

function logError(message: string): void {
  console.error(`[${ts()}] [monitor:loop] ${message}`);
}

/**
 * Cooperative sleep that wakes every second so a pending shutdown signal can
 * short-circuit the wait. Returns when either the deadline elapses or
 * `isStopRequested()` flips true.
 */
function sleepUntilStoppedOrDeadline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const handle = setInterval(() => {
      if (isStopRequested() || Date.now() - start >= ms) {
        clearInterval(handle);
        resolve();
      }
    }, 1000);
  });
}

async function main(): Promise<void> {
  installShutdownHandlers();
  const intervalSeconds = resolveIntervalSeconds();
  log(
    `starting dev loop — interval=${intervalSeconds}s. For production, schedule \`npm run monitor:tick\` via cron / systemd timer (see docs/deployment.md).`,
  );

  while (!isStopRequested()) {
    try {
      await runOneTick();
    } catch (error) {
      logError(`tick error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (isStopRequested()) break;
    log(`sleeping ${intervalSeconds}s`);
    await sleepUntilStoppedOrDeadline(intervalSeconds * 1000);
  }
  log("stopped");
}

main().catch((error) => {
  logError(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});

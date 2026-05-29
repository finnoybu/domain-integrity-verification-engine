import {
  getLastAlerted,
  setLastAlerted,
  type LastAlertedRecord,
} from "./storage";
import { dispatchEmail, dispatchWebhook } from "./alert-channels";
import {
  effectiveRoutesForDomain,
  loadAlertingConfig,
  type AlertChannel,
  type AlertRoute,
  type AlertSeverity,
  type SmtpChannelConfig,
  type WebhookChannelConfig,
} from "./alert-config";

// ============================================================================
// Alerting — Monitor Phase D, persisted under PR 5.
//
// Pipeline per tick / per domain:
//
//   1. Compute alert events from state transitions (pure;
//      computeAlertEvents). Field-level first observation yields no event so
//      a fresh install / newly-added domain does not spam.
//   2. Resolve the effective routes for the domain (OVERRIDE: per-domain
//      routes replace defaults when present; see alert-config.ts).
//   3. Per event, match against routes whose severities include this
//      event's severity AND whose channel is enabled. Group resulting
//      (channel → events) batches.
//   4. Dispatch each batch via dispatchEmail / dispatchWebhook (the channel
//      types). Errors are recorded per channel; dispatch failure does NOT
//      block lastAlerted advancement (so a broken channel doesn't trigger
//      re-alerts every tick).
//   5. Persist lastAlerted.
//
// The monitor tick is the only producer — dashboard / on-demand snapshots
// update domain state but never dispatch, which keeps alert ordering
// deterministic and avoids cross-process races.
// ============================================================================

export type { AlertSeverity } from "./alert-config";

export type AlertKind = "stability_transition" | "ownership_transition";

export interface AlertEvent {
  domain: string;
  kind: AlertKind;
  severity: AlertSeverity;
  from: string | null;
  to: string;
  message: string;
  timestamp: string;
}

function stabilitySeverity(to: string): AlertSeverity | null {
  switch (to) {
    case "baseline":
      return null; // initial — not alert-worthy on its own
    case "stable":
      return "info"; // recovery (or first stable observation)
    case "drift":
      return "warning";
    case "risk":
    case "critical":
    case "invalid":
      return "critical";
    default:
      return null;
  }
}

function ownershipSeverity(to: string): AlertSeverity | null {
  switch (to) {
    case "ownership_unverified":
      return null; // initial setup state — not alert-worthy
    case "ownership_failed":
      return "critical";
    case "ownership_verified":
      return "info"; // setup confirmation or recovery from failed
    default:
      return null;
  }
}

export interface CurrentStates {
  /** Latest stability classification this tick. Omit if not observed (e.g., ownership gate failed). */
  stabilityState?: string;
  /** Latest ownership state this tick. Omit if not observed. */
  ownershipState?: string;
}

/**
 * Pure: computes the alert events that would fire given the current
 * observation and the previously-alerted state. A field-level first
 * observation (lastAlerted's field is null) yields no event.
 */
export function computeAlertEvents(
  domain: string,
  current: CurrentStates,
  lastAlerted: LastAlertedRecord | null,
  timestamp: string,
): AlertEvent[] {
  const events: AlertEvent[] = [];
  const prevStability = lastAlerted?.stabilityState ?? null;
  const prevOwnership = lastAlerted?.ownershipState ?? null;

  if (
    current.stabilityState !== undefined &&
    prevStability !== null &&
    prevStability !== current.stabilityState
  ) {
    const severity = stabilitySeverity(current.stabilityState);
    if (severity !== null) {
      events.push({
        domain,
        kind: "stability_transition",
        severity,
        from: prevStability,
        to: current.stabilityState,
        message: `Stability state for ${domain} transitioned from ${prevStability} to ${current.stabilityState}.`,
        timestamp,
      });
    }
  }

  if (
    current.ownershipState !== undefined &&
    prevOwnership !== null &&
    prevOwnership !== current.ownershipState
  ) {
    const severity = ownershipSeverity(current.ownershipState);
    if (severity !== null) {
      events.push({
        domain,
        kind: "ownership_transition",
        severity,
        from: prevOwnership,
        to: current.ownershipState,
        message: `Ownership state for ${domain} transitioned from ${prevOwnership} to ${current.ownershipState}.`,
        timestamp,
      });
    }
  }

  return events;
}

export interface AlertingSet {
  channels: AlertChannel[];
  routes: AlertRoute[];
}

export interface ProcessAlertsResult {
  events: AlertEvent[];
  /** Number of channels successfully dispatched to. */
  dispatched: number;
  errors: Array<{ channel: string; error: string }>;
  /** True when this was the first observation for the domain (silent init). */
  initialized: boolean;
}

/**
 * Resolves the per-channel event batches for a domain under the override
 * model. A channel receives an event only if there's a matching route (in the
 * domain's effective set) whose severities include the event's severity AND
 * the channel itself is enabled. Used by processAlerts; exported for tests.
 */
export function dispatchPlanForDomain(
  domain: string,
  events: AlertEvent[],
  set: AlertingSet,
): Map<number, AlertEvent[]> {
  const routes = effectiveRoutesForDomain(domain, set.routes);
  const channelsById = new Map(set.channels.map((c) => [c.id, c]));
  const plan = new Map<number, AlertEvent[]>();
  for (const event of events) {
    for (const route of routes) {
      if (!route.severities.includes(event.severity)) continue;
      const channel = channelsById.get(route.channelId);
      if (!channel || !channel.enabled) continue;
      const batch = plan.get(channel.id) ?? [];
      // De-dup: the same channel may match via two routes (rare, but
      // possible if both list the severity); only count the event once.
      if (!batch.includes(event)) batch.push(event);
      plan.set(channel.id, batch);
    }
  }
  return plan;
}

/**
 * Computes transitions, dispatches via the channels resolved by the routing
 * rules, and persists the next `lastAlerted`. The lastAlerted is updated
 * regardless of dispatch success so a broken channel does not cause re-alerts
 * on every tick. `config` is the pre-loaded channel + route set; pass it once
 * per tick from the worker and reuse across domains (cheaper than re-querying).
 */
export async function processAlerts(
  domain: string,
  current: CurrentStates,
  config?: AlertingSet,
): Promise<ProcessAlertsResult> {
  const set = config ?? (await loadAlertingConfig());
  const lastAlerted = await getLastAlerted(domain);
  const timestamp = new Date().toISOString();

  const events = computeAlertEvents(domain, current, lastAlerted, timestamp);

  let dispatched = 0;
  const errors: Array<{ channel: string; error: string }> = [];

  if (events.length > 0) {
    const plan = dispatchPlanForDomain(domain, events, set);
    const channelsById = new Map(set.channels.map((c) => [c.id, c]));
    for (const [channelId, batch] of plan) {
      const channel = channelsById.get(channelId);
      if (!channel || batch.length === 0) continue;
      try {
        if (channel.type === "smtp") {
          await dispatchEmail(batch, channel.config as SmtpChannelConfig);
        } else if (channel.type === "webhook") {
          await dispatchWebhook(batch, channel.config as WebhookChannelConfig);
        } else {
          throw new Error(`unknown channel type: ${channel.type}`);
        }
        dispatched += 1;
      } catch (error) {
        errors.push({
          channel: `${channel.type}#${channel.id} (${channel.name})`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Persist next lastAlerted — preserve old values where this tick didn't
  // observe. lastAlertedAt only ticks if we actually fired events.
  const nextStability =
    current.stabilityState ?? lastAlerted?.stabilityState ?? null;
  const nextOwnership =
    current.ownershipState ?? lastAlerted?.ownershipState ?? null;
  const nextLastAlertedAt =
    events.length > 0 ? timestamp : lastAlerted?.lastAlertedAt ?? null;

  await setLastAlerted(domain, {
    stabilityState: nextStability,
    ownershipState: nextOwnership,
    lastAlertedAt: nextLastAlertedAt,
  });

  return {
    events,
    dispatched,
    errors,
    initialized: lastAlerted === null,
  };
}

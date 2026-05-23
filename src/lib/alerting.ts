import fs from "fs/promises";
import path from "path";
import {
  getLastAlerted,
  setLastAlerted,
  type LastAlertedRecord,
} from "./storage";
import { dispatchEmail, dispatchWebhook } from "./alert-channels";

// ============================================================================
// Alerting — Monitor Phase D.
//
// Computes alert events from state transitions, deduplicates against the
// persisted `lastAlerted` record per domain, and dispatches via the
// configured channels. The monitor worker is the only producer (see
// docs/monitoring-design.md): dashboard / on-demand snapshots update domain
// state but never dispatch — that keeps alert ordering deterministic and
// avoids cross-process races.
//
// First-observation semantics: the very first time a field is observed for
// a domain (no prior lastAlerted, or null for that field), the value is
// recorded silently — no event, no dispatch. That's what keeps a fresh
// install / newly-added domain from spamming.
// ============================================================================

const CONFIG_FILE = path.join(process.cwd(), "alerts.local.json");

export type AlertSeverity = "info" | "warning" | "critical";

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

export interface EmailChannelConfig {
  enabled?: boolean;
  /** RFC 5322 From address. */
  from?: string;
  /** Recipient list. */
  to?: string[];
}

export interface WebhookChannelConfig {
  enabled?: boolean;
  /** Full URL to POST to (Slack incoming webhook, MS Teams, custom HTTP endpoint). */
  url?: string;
  /** HTTP method. Defaults to POST. */
  method?: string;
  /** Extra headers (auth tokens, custom labels). */
  headers?: Record<string, string>;
}

export interface AlertConfig {
  channels: {
    email: EmailChannelConfig;
    webhook: WebhookChannelConfig;
  };
  /** Which severities trigger dispatch. info defaults off (often noise). */
  severities: {
    info: boolean;
    warning: boolean;
    critical: boolean;
  };
}

const DEFAULT_CONFIG: AlertConfig = {
  channels: {
    email: { enabled: false },
    webhook: { enabled: false },
  },
  severities: {
    info: false,
    warning: true,
    critical: true,
  },
};

/**
 * Loads `alerts.local.json` if present and shallow-merges it onto the
 * defaults. Missing / malformed file → defaults. Unknown fields are
 * preserved through the merge but ignored by the rest of the code.
 */
export async function loadAlertConfig(): Promise<AlertConfig> {
  try {
    const content = await fs.readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(content) as Partial<AlertConfig>;
    return mergeAlertConfig(DEFAULT_CONFIG, parsed);
  } catch {
    // File missing or invalid — fall back to defaults. The worker will
    // log "would dispatch" events but won't actually send anything.
    return DEFAULT_CONFIG;
  }
}

function mergeAlertConfig(
  defaults: AlertConfig,
  partial: Partial<AlertConfig>,
): AlertConfig {
  return {
    channels: {
      email: {
        ...defaults.channels.email,
        ...(partial.channels?.email ?? {}),
      },
      webhook: {
        ...defaults.channels.webhook,
        ...(partial.channels?.webhook ?? {}),
      },
    },
    severities: {
      ...defaults.severities,
      ...(partial.severities ?? {}),
    },
  };
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

export interface ProcessAlertsResult {
  events: AlertEvent[];
  /** Number of channels successfully dispatched to. */
  dispatched: number;
  errors: Array<{ channel: string; error: string }>;
  /** True when this was the first observation for the domain (silent init). */
  initialized: boolean;
}

/**
 * Computes transitions, dispatches via enabled channels (filtered by the
 * severities config), and persists the next `lastAlerted`. The lastAlerted
 * is updated regardless of dispatch success so a broken channel does not
 * cause re-alerts on every tick.
 */
export async function processAlerts(
  domain: string,
  current: CurrentStates,
  config?: AlertConfig,
): Promise<ProcessAlertsResult> {
  const cfg = config ?? (await loadAlertConfig());
  const lastAlerted = await getLastAlerted(domain);
  const timestamp = new Date().toISOString();

  const events = computeAlertEvents(domain, current, lastAlerted, timestamp);

  let dispatched = 0;
  const errors: Array<{ channel: string; error: string }> = [];

  const dispatchable = events.filter((e) => cfg.severities[e.severity]);
  if (dispatchable.length > 0) {
    if (cfg.channels.email.enabled) {
      try {
        await dispatchEmail(dispatchable, cfg.channels.email);
        dispatched += 1;
      } catch (error) {
        errors.push({
          channel: "email",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (cfg.channels.webhook.enabled) {
      try {
        await dispatchWebhook(dispatchable, cfg.channels.webhook);
        dispatched += 1;
      } catch (error) {
        errors.push({
          channel: "webhook",
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

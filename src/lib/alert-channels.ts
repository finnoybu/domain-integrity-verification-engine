import { sendEmail } from "./email";
import type {
  AlertEvent,
  EmailChannelConfig,
  WebhookChannelConfig,
} from "./alerting";

// ============================================================================
// Alert dispatch channels.
//
// Email: thin wrapper over the shared SMTP primitive in ./email.ts (same
//   DIVE_SMTP_* env vars; magic-link sign-in uses the same transport). The
//   JSON config holds only the from/to lists so it's safe to commit a
//   redacted version.
//
// Webhook: HTTP POST of the events array to a configured URL. Covers Slack
//   incoming webhooks, MS Teams connectors, and any custom HTTP endpoint
//   the operator wants to wire DIVE into.
//
// Both throw on dispatch failure; the caller (processAlerts) catches and
// records per-channel errors without updating the alert state, so a broken
// channel does not block dispatch on the next transition through other
// channels but also does not stop the persisted-state advance.
// ============================================================================

const WEBHOOK_TIMEOUT_MS = 10_000;

export async function dispatchEmail(
  events: AlertEvent[],
  config: EmailChannelConfig,
): Promise<void> {
  if (events.length === 0) return;
  if (!config.from) {
    throw new Error("email channel: 'from' is required in alerts.local.json");
  }
  if (!config.to || config.to.length === 0) {
    throw new Error("email channel: 'to' recipient list is required in alerts.local.json");
  }

  await sendEmail({
    from: config.from,
    to: config.to,
    subject: formatSubject(events),
    text: formatTextBody(events),
  });
}

export async function dispatchWebhook(
  events: AlertEvent[],
  config: WebhookChannelConfig,
): Promise<void> {
  if (events.length === 0) return;
  if (!config.url) {
    throw new Error("webhook channel: 'url' is required in alerts.local.json");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(config.url, {
      method: config.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `webhook dispatch returned HTTP ${response.status} ${response.statusText}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function dominantSeverity(events: AlertEvent[]): AlertEvent["severity"] {
  if (events.some((e) => e.severity === "critical")) return "critical";
  if (events.some((e) => e.severity === "warning")) return "warning";
  return "info";
}

function formatSubject(events: AlertEvent[]): string {
  const severity = dominantSeverity(events).toUpperCase();
  if (events.length === 1) {
    const e = events[0];
    return `[DIVE ${severity}] ${e.domain}: ${e.kind.replace(/_/g, " ")} (${e.from ?? "?"} → ${e.to})`;
  }
  const uniqueDomains = new Set(events.map((e) => e.domain)).size;
  return `[DIVE ${severity}] ${events.length} alerts across ${uniqueDomains} domain${uniqueDomains === 1 ? "" : "s"}`;
}

function formatTextBody(events: AlertEvent[]): string {
  return events
    .map(
      (e) =>
        `[${e.severity.toUpperCase()}] ${e.domain}\n${e.message}\nfrom: ${e.from ?? "(unknown)"} → to: ${e.to}\nat:   ${e.timestamp}`,
    )
    .join("\n\n----\n\n");
}

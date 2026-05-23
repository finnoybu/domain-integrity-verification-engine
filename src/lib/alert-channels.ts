import nodemailer from "nodemailer";
import type {
  AlertEvent,
  EmailChannelConfig,
  WebhookChannelConfig,
} from "./alerting";

// ============================================================================
// Alert dispatch channels.
//
// Email: nodemailer over SMTP. Works against AWS SES SMTP, Sendgrid SMTP,
//   Mailgun SMTP, or any generic SMTP relay — the operator picks. SMTP
//   credentials live in env vars (DIVE_SMTP_*); the JSON config holds only
//   the from/to lists so it's safe to commit a redacted version.
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

const SMTP_TIMEOUT_MS = 10_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

interface SmtpEnv {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

function resolveSmtpEnv(): SmtpEnv {
  const host = process.env.DIVE_SMTP_HOST;
  if (!host) {
    throw new Error(
      "email channel: DIVE_SMTP_HOST is not set (DIVE_SMTP_PORT, DIVE_SMTP_USER, DIVE_SMTP_PASS, DIVE_SMTP_SECURE are also read)",
    );
  }
  const portRaw = Number(process.env.DIVE_SMTP_PORT ?? "587");
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 587;
  return {
    host,
    port,
    secure: process.env.DIVE_SMTP_SECURE === "true",
    user: process.env.DIVE_SMTP_USER || undefined,
    pass: process.env.DIVE_SMTP_PASS || undefined,
  };
}

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

  const smtp = resolveSmtpEnv();
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  try {
    await transporter.sendMail({
      from: config.from,
      to: config.to.join(", "),
      subject: formatSubject(events),
      text: formatTextBody(events),
    });
  } finally {
    transporter.close();
  }
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

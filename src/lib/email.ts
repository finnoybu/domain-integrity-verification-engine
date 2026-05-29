import nodemailer, { type Transporter } from "nodemailer";

// ============================================================================
// SMTP email primitive — shared between alert dispatch and magic-link sign-in.
//
// Both callers used to roll their own SMTP transport; consolidating here means
// adding a third email-emitting feature (digests, reports, …) does not duplicate
// the env-var contract or the timeout discipline. Connection setup happens per
// call — fine for low-volume alerting + interactive sign-in; pool here if
// volume ever justifies it.
//
// Configuration is via environment variables (same set the alerting layer has
// always read; documented in docs/deployment.md):
//   - DIVE_SMTP_HOST     required
//   - DIVE_SMTP_PORT     defaults to 587
//   - DIVE_SMTP_SECURE   "true" enables TLS-on-connect (port 465 style)
//   - DIVE_SMTP_USER     optional SASL user
//   - DIVE_SMTP_PASS     optional SASL pass (paired with USER)
//
// Each caller supplies its own `from` — alerting reads from alerts.local.json,
// the magic-link issuer reads `DIVE_AUTH_FROM`. Centralising the transport but
// not the sender keeps each feature's configuration story coherent.
// ============================================================================

const SMTP_TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string | string[];
  from: string;
  subject: string;
  text: string;
  html?: string;
}

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
      "SMTP not configured: DIVE_SMTP_HOST is not set (DIVE_SMTP_PORT, DIVE_SMTP_USER, DIVE_SMTP_PASS, DIVE_SMTP_SECURE are also read)",
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

function createSmtpTransport(): Transporter {
  const smtp = resolveSmtpEnv();
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

/**
 * Sends a single email over the configured SMTP transport. Throws on any
 * delivery failure so the caller can decide whether to retry, log, or surface
 * the error — this primitive is intentionally side-effecting and unforgiving.
 *
 * `to` accepts a string or an array; multiple recipients are joined into a
 * single comma-separated header (one outbound message, not per-recipient
 * fan-out).
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  if (!message.from) {
    throw new Error("sendEmail: 'from' is required");
  }
  const recipients = Array.isArray(message.to) ? message.to : [message.to];
  if (recipients.length === 0 || recipients.some((r) => !r)) {
    throw new Error("sendEmail: 'to' must be a non-empty address (or list of addresses)");
  }

  const transporter = createSmtpTransport();
  try {
    await transporter.sendMail({
      from: message.from,
      to: recipients.join(", "),
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } finally {
    transporter.close();
  }
}

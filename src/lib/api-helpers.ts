import { NextRequest, NextResponse } from "next/server";

export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "rate_limited"
  | "upstream_failure"
  | "internal_error"
  | "license_limit";

interface ErrorPayload {
  error: string;
  code: ErrorCode;
  message: string;
  request_id?: string;
}

interface ErrorOptions {
  requestId?: string;
}

interface UnauthorizedPayload {
  error: "unauthorized";
  code: "AUTH_REQUIRED";
  message: "Valid authorization token required";
  request_id?: string;
}

export function getRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function logServerError(requestId: string, context: string, error: unknown): void {
  console.error(`[${requestId}] ${context}:`, error);
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  status: number,
  options: ErrorOptions = {}
): NextResponse<ErrorPayload> {
  const payload: ErrorPayload = {
    error: code,
    code,
    message,
    ...(options.requestId ? { request_id: options.requestId } : {}),
  };

  return NextResponse.json(payload, { status });
}

export function badRequest(message: string, requestId?: string): NextResponse<ErrorPayload> {
  return errorResponse("invalid_input", message, 400, { requestId });
}

export function notFound(message: string, requestId?: string): NextResponse<ErrorPayload> {
  return errorResponse("not_found", message, 404, { requestId });
}

export function licenseLimitReached(
  message: string,
  requestId?: string,
): NextResponse<ErrorPayload> {
  return errorResponse("license_limit", message, 403, { requestId });
}

export function upstreamFailure(message: string, requestId?: string): NextResponse<ErrorPayload> {
  return errorResponse("upstream_failure", message, 502, { requestId });
}

export function internalError(message: string, requestId?: string): NextResponse<ErrorPayload> {
  return errorResponse("internal_error", message, 500, { requestId });
}

export function authRequired(requestId?: string): NextResponse<UnauthorizedPayload> {
  const payload: UnauthorizedPayload = {
    error: "unauthorized",
    code: "AUTH_REQUIRED",
    message: "Valid authorization token required",
    ...(requestId ? { request_id: requestId } : {}),
  };

  return NextResponse.json(payload, { status: 401 });
}

// Optional in-memory sliding-window rate limiting (disabled by default)
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED === "true";
const RATE_LIMIT_WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? "60");
const RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.RATE_LIMIT_MAX_REQUESTS_PER_IP_PER_WINDOW
    ?? process.env.RATE_LIMIT_MAX_REQUESTS_PER_IP
    ?? "30"
);

const rateWindowMs = Math.max(1, RATE_LIMIT_WINDOW_SECONDS) * 1000;
const rateMaxRequests = Math.max(1, RATE_LIMIT_MAX_REQUESTS);

type RequestBucket = {
  timestamps: number[];
};

const ipBuckets = new Map<string, RequestBucket>();

function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return request.headers.get("x-real-ip") || "unknown";
}

export function enforceRateLimit(request: NextRequest, requestId: string): NextResponse<ErrorPayload> | null {
  if (!RATE_LIMIT_ENABLED) {
    return null;
  }

  const ip = getClientIp(request);
  const now = Date.now();

  const existing = ipBuckets.get(ip) || { timestamps: [] };
  const cutoff = now - rateWindowMs;
  const kept = existing.timestamps.filter((ts) => ts > cutoff);

  if (kept.length >= rateMaxRequests) {
    const oldestInWindow = kept[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + rateWindowMs - now) / 1000));

    const response = errorResponse(
      "rate_limited",
      "Too many requests. Please retry later.",
      429,
      { requestId }
    );

    response.headers.set("Retry-After", String(retryAfterSeconds));
    return response;
  }

  kept.push(now);
  ipBuckets.set(ip, { timestamps: kept });
  return null;
}

import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  enforceRateLimit,
  getRequestId,
  internalError,
  logServerError,
} from "@/lib/api-helpers";
import { requireAuth } from "@/lib/auth-server";
import {
  clearDomainSetting,
  clearGlobalSetting,
  listDomainSettings,
  listGlobalSettings,
  setDomainSetting,
  setGlobalSetting,
  type DomainSettingKey,
  type GlobalSettingKey,
} from "@/lib/settings";

const GLOBAL_KEYS: readonly GlobalSettingKey[] = [
  "monitor_interval_seconds",
  "snapshot_retention",
  "ownership_lookup_timeout_ms",
];

const DOMAIN_KEYS: readonly DomainSettingKey[] = ["monitor_interval_seconds"];

function isGlobalKey(value: unknown): value is GlobalSettingKey {
  return typeof value === "string" && GLOBAL_KEYS.includes(value as GlobalSettingKey);
}

function isDomainKey(value: unknown): value is DomainSettingKey {
  return typeof value === "string" && DOMAIN_KEYS.includes(value as DomainSettingKey);
}

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

/**
 * GET  /api/settings                 → { globals }
 * GET  /api/settings?domain=foo.com  → { globals, domainSettings }
 * POST /api/settings  body actions:
 *   set_global    { key, value }       → { ok: true }
 *   clear_global  { key }              → { ok: true }
 *   set_domain    { domain, key, value }
 *   clear_domain  { domain, key }
 *
 * All gated by requireAuth (session cookie OR api-token bearer).
 */
export async function GET(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) return rateLimited;

  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const domain = normalizeDomain(request.nextUrl.searchParams.get("domain"));
    const globals = await listGlobalSettings();
    if (domain) {
      const domainSettings = await listDomainSettings(domain);
      return NextResponse.json({ globals, domainSettings });
    }
    return NextResponse.json({ globals });
  } catch (error) {
    logServerError(requestId, "GET /api/settings error", error);
    return internalError("Failed to load settings", requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) return rateLimited;

  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return badRequest("Request body must be a JSON object", requestId);
    }

    switch (body.action) {
      case "set_global":
        return handleSetGlobal(body, requestId);
      case "clear_global":
        return handleClearGlobal(body, requestId);
      case "set_domain":
        return handleSetDomain(body, requestId);
      case "clear_domain":
        return handleClearDomain(body, requestId);
      default:
        return badRequest(`Unknown action: ${String(body.action ?? "(missing)")}`, requestId);
    }
  } catch (error) {
    // Settings validation errors throw — surface their message as a 400.
    if (error instanceof Error && /must be an integer in/.test(error.message)) {
      return badRequest(error.message, requestId);
    }
    logServerError(requestId, "POST /api/settings error", error);
    return internalError("Failed to mutate settings", requestId);
  }
}

async function handleSetGlobal(body: Record<string, unknown>, requestId: string) {
  if (!isGlobalKey(body.key)) {
    return badRequest(`key must be one of: ${GLOBAL_KEYS.join(", ")}`, requestId);
  }
  const value = Number(body.value);
  if (!Number.isInteger(value)) {
    return badRequest("value must be an integer", requestId);
  }
  await setGlobalSetting(body.key, value);
  return NextResponse.json({ ok: true });
}

async function handleClearGlobal(body: Record<string, unknown>, requestId: string) {
  if (!isGlobalKey(body.key)) {
    return badRequest(`key must be one of: ${GLOBAL_KEYS.join(", ")}`, requestId);
  }
  await clearGlobalSetting(body.key);
  return NextResponse.json({ ok: true });
}

async function handleSetDomain(body: Record<string, unknown>, requestId: string) {
  const domain = normalizeDomain(body.domain);
  if (!domain) return badRequest("domain is required", requestId);
  if (!isDomainKey(body.key)) {
    return badRequest(`key must be one of: ${DOMAIN_KEYS.join(", ")}`, requestId);
  }
  const value = Number(body.value);
  if (!Number.isInteger(value)) {
    return badRequest("value must be an integer", requestId);
  }
  await setDomainSetting(domain, body.key, value);
  return NextResponse.json({ ok: true });
}

async function handleClearDomain(body: Record<string, unknown>, requestId: string) {
  const domain = normalizeDomain(body.domain);
  if (!domain) return badRequest("domain is required", requestId);
  if (!isDomainKey(body.key)) {
    return badRequest(`key must be one of: ${DOMAIN_KEYS.join(", ")}`, requestId);
  }
  await clearDomainSetting(domain, body.key);
  return NextResponse.json({ ok: true });
}

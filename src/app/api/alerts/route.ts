import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  enforceRateLimit,
  getRequestId,
  internalError,
  logServerError,
  notFound,
} from "@/lib/api-helpers";
import { requireAuth } from "@/lib/auth-server";
import {
  createChannel,
  createRoute,
  deleteChannel,
  deleteRoute,
  getChannel,
  listChannels,
  listRoutes,
  sanitizeSeverities,
  updateChannel,
  type AlertChannelType,
  type AlertSeverity,
  type RouteScopeType,
  type SmtpChannelConfig,
  type WebhookChannelConfig,
} from "@/lib/alert-config";

const CHANNEL_TYPES: readonly AlertChannelType[] = ["smtp", "webhook"];
const SCOPE_TYPES: readonly RouteScopeType[] = ["all", "domain"];

/**
 * GET  /api/alerts  → { channels, routes }
 * POST /api/alerts  → action-dispatched mutations:
 *   create_channel  { type, name, config, enabled? }       → { channel }
 *   update_channel  { id, name?, config?, enabled? }       → { channel }
 *   delete_channel  { id }                                 → { ok: true } | 404
 *   create_route    { scopeType, scopeValue?, channelId,
 *                     severities }                         → { route }
 *   delete_route    { id }                                 → { ok: true } | 404
 *
 * Every path requires a valid session cookie OR api-token bearer (requireAuth).
 */
export async function GET(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) return rateLimited;

  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const [channels, routes] = await Promise.all([listChannels(), listRoutes()]);
    return NextResponse.json({ channels, routes });
  } catch (error) {
    logServerError(requestId, "GET /api/alerts error", error);
    return internalError("Failed to load alert configuration", requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = getRequestId();

  const rateLimited = enforceRateLimit(request, requestId);
  if (rateLimited) return rateLimited;

  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!body || typeof body !== "object") {
      return badRequest("Request body must be a JSON object", requestId);
    }
    const action = body.action;

    switch (action) {
      case "create_channel":
        return handleCreateChannel(body, requestId);
      case "update_channel":
        return handleUpdateChannel(body, requestId);
      case "delete_channel":
        return handleDeleteChannel(body, requestId);
      case "create_route":
        return handleCreateRoute(body, requestId);
      case "delete_route":
        return handleDeleteRoute(body, requestId);
      default:
        return badRequest(
          `Unknown action: ${String(action ?? "(missing)")}`,
          requestId,
        );
    }
  } catch (error) {
    logServerError(requestId, "POST /api/alerts error", error);
    return internalError("Failed to mutate alert configuration", requestId);
  }
}

// ---------------------------------------------------------------------------
// Action handlers.
// ---------------------------------------------------------------------------

function isAlertChannelType(value: unknown): value is AlertChannelType {
  return typeof value === "string" && CHANNEL_TYPES.includes(value as AlertChannelType);
}

function isRouteScopeType(value: unknown): value is RouteScopeType {
  return typeof value === "string" && SCOPE_TYPES.includes(value as RouteScopeType);
}

function validateChannelConfig(
  type: AlertChannelType,
  raw: unknown,
): { ok: true; config: SmtpChannelConfig | WebhookChannelConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "config must be an object" };
  }
  const c = raw as Record<string, unknown>;
  if (type === "smtp") {
    const from = c.from;
    const to = c.to;
    if (typeof from !== "string" || !from.trim()) {
      return { ok: false, error: "smtp config requires 'from' (string)" };
    }
    if (!Array.isArray(to) || to.length === 0 || to.some((t) => typeof t !== "string" || !t)) {
      return { ok: false, error: "smtp config requires 'to' (non-empty string array)" };
    }
    return { ok: true, config: { from, to: to as string[] } };
  }
  // webhook
  const url = c.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return { ok: false, error: "webhook config requires 'url' (http(s):// URL)" };
  }
  const method = typeof c.method === "string" ? c.method : "POST";
  const headers =
    c.headers && typeof c.headers === "object" && !Array.isArray(c.headers)
      ? (c.headers as Record<string, string>)
      : {};
  return { ok: true, config: { url, method, headers } };
}

async function handleCreateChannel(body: Record<string, unknown>, requestId: string) {
  const type = body.type;
  if (!isAlertChannelType(type)) {
    return badRequest("type must be 'smtp' or 'webhook'", requestId);
  }
  const name = typeof body.name === "string" ? body.name : "";
  if (!name.trim()) {
    return badRequest("name is required", requestId);
  }
  const validation = validateChannelConfig(type, body.config);
  if (!validation.ok) return badRequest(validation.error, requestId);

  const channel = await createChannel({
    type,
    name,
    config: validation.config,
    enabled: body.enabled === false ? false : true,
  });
  return NextResponse.json({ channel }, { status: 201 });
}

async function handleUpdateChannel(body: Record<string, unknown>, requestId: string) {
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return badRequest("id (integer) is required", requestId);
  }
  const existing = await getChannel(id);
  if (!existing) return notFound("Channel not found", requestId);

  const patch: Parameters<typeof updateChannel>[1] = {};
  if (typeof body.name === "string") {
    if (!body.name.trim()) return badRequest("name cannot be empty", requestId);
    patch.name = body.name;
  }
  if (body.config !== undefined) {
    const validation = validateChannelConfig(existing.type, body.config);
    if (!validation.ok) return badRequest(validation.error, requestId);
    patch.config = validation.config;
  }
  if (typeof body.enabled === "boolean") {
    patch.enabled = body.enabled;
  }
  await updateChannel(id, patch);
  const updated = await getChannel(id);
  return NextResponse.json({ channel: updated });
}

async function handleDeleteChannel(body: Record<string, unknown>, requestId: string) {
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return badRequest("id (integer) is required", requestId);
  }
  const ok = await deleteChannel(id);
  if (!ok) return notFound("Channel not found", requestId);
  return NextResponse.json({ ok: true });
}

async function handleCreateRoute(body: Record<string, unknown>, requestId: string) {
  const scopeType = body.scopeType;
  if (!isRouteScopeType(scopeType)) {
    return badRequest("scopeType must be 'all' or 'domain'", requestId);
  }
  const channelId = Number(body.channelId);
  if (!Number.isInteger(channelId)) {
    return badRequest("channelId (integer) is required", requestId);
  }
  const scopeValue =
    scopeType === "domain"
      ? typeof body.scopeValue === "string"
        ? body.scopeValue.trim().toLowerCase()
        : ""
      : null;
  if (scopeType === "domain" && !scopeValue) {
    return badRequest("scopeValue (domain name) is required for a 'domain' route", requestId);
  }
  const severities = sanitizeSeverities(body.severities);
  if (severities.length === 0) {
    return badRequest("severities must include at least one of info|warning|critical", requestId);
  }
  const channel = await getChannel(channelId);
  if (!channel) return notFound("Channel not found", requestId);

  const route = await createRoute({
    scopeType,
    scopeValue,
    channelId,
    severities: severities as AlertSeverity[],
  });
  return NextResponse.json({ route }, { status: 201 });
}

async function handleDeleteRoute(body: Record<string, unknown>, requestId: string) {
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return badRequest("id (integer) is required", requestId);
  }
  const ok = await deleteRoute(id);
  if (!ok) return notFound("Route not found", requestId);
  return NextResponse.json({ ok: true });
}

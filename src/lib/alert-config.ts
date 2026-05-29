import { getDb } from "./db";
import type { AlertSeverity } from "./alerting";

// ============================================================================
// Persisted alert configuration (PR 5). Channels and routes live in SQLite
// (alert_channels / alert_routes), replacing alerts.local.json. The monitor
// tick reads this each pass, so dashboard edits take effect on the next tick
// with no restart.
//
// Routing model (resolution = OVERRIDE): a route is scoped 'all' (default) or
// 'domain' (a single domain). For a given domain, if it has any 'domain'
// routes those fully replace the defaults; otherwise the 'all' routes apply.
// Each route forwards a set of severities to one channel.
//
// SMTP credentials still come from DIVE_SMTP_* env vars; a channel's config
// holds only routing-relevant data (from/to, or url/method/headers).
// ============================================================================

export type AlertChannelType = "smtp" | "webhook";

export interface SmtpChannelConfig {
  from: string;
  to: string[];
}

export interface WebhookChannelConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

export type AlertChannelConfig = SmtpChannelConfig | WebhookChannelConfig;

export interface AlertChannel {
  id: number;
  type: AlertChannelType;
  name: string;
  config: AlertChannelConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RouteScopeType = "all" | "domain";

export interface AlertRoute {
  id: number;
  scopeType: RouteScopeType;
  /** null for 'all'; the domain name for 'domain'. */
  scopeValue: string | null;
  channelId: number;
  severities: AlertSeverity[];
  createdAt: string;
}

const ALL_SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];

interface ChannelRow {
  id: number;
  type: string;
  name: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RouteRow {
  id: number;
  scope_type: string;
  scope_value: string | null;
  channel_id: number;
  severities_json: string;
  created_at: string;
}

function rowToChannel(row: ChannelRow): AlertChannel {
  return {
    id: row.id,
    type: row.type as AlertChannelType,
    name: row.name,
    config: JSON.parse(row.config_json) as AlertChannelConfig,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRoute(row: RouteRow): AlertRoute {
  return {
    id: row.id,
    scopeType: row.scope_type as RouteScopeType,
    scopeValue: row.scope_value,
    channelId: row.channel_id,
    severities: sanitizeSeverities(JSON.parse(row.severities_json)),
    createdAt: row.created_at,
  };
}

/** Drops anything that isn't a known severity; preserves canonical order. */
export function sanitizeSeverities(input: unknown): AlertSeverity[] {
  if (!Array.isArray(input)) return [];
  return ALL_SEVERITIES.filter((s) => input.includes(s));
}

// ----------------------------------------------------------------------------
// Channels.
// ----------------------------------------------------------------------------

export async function listChannels(): Promise<AlertChannel[]> {
  return getDb()
    .prepare<[], ChannelRow>("SELECT * FROM alert_channels ORDER BY id ASC")
    .all()
    .map(rowToChannel);
}

export async function getChannel(id: number): Promise<AlertChannel | null> {
  const row = getDb()
    .prepare<[number], ChannelRow>("SELECT * FROM alert_channels WHERE id = ?")
    .get(id);
  return row ? rowToChannel(row) : null;
}

export async function createChannel(input: {
  type: AlertChannelType;
  name: string;
  config: AlertChannelConfig;
  enabled?: boolean;
}): Promise<AlertChannel> {
  const result = getDb()
    .prepare(
      `INSERT INTO alert_channels (type, name, config_json, enabled)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.type,
      input.name.trim() || input.type,
      JSON.stringify(input.config),
      input.enabled === false ? 0 : 1,
    );
  const created = await getChannel(Number(result.lastInsertRowid));
  if (!created) throw new Error("createChannel: insert did not round-trip");
  return created;
}

export async function updateChannel(
  id: number,
  patch: { name?: string; config?: AlertChannelConfig; enabled?: boolean },
): Promise<boolean> {
  const existing = await getChannel(id);
  if (!existing) return false;
  const next = {
    name: patch.name?.trim() || existing.name,
    config: patch.config ?? existing.config,
    enabled: patch.enabled ?? existing.enabled,
  };
  const result = getDb()
    .prepare(
      `UPDATE alert_channels
       SET name = ?, config_json = ?, enabled = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(next.name, JSON.stringify(next.config), next.enabled ? 1 : 0, id);
  return result.changes > 0;
}

export async function deleteChannel(id: number): Promise<boolean> {
  // Routes referencing this channel cascade (FK ON DELETE CASCADE).
  const result = getDb().prepare("DELETE FROM alert_channels WHERE id = ?").run(id);
  return result.changes > 0;
}

// ----------------------------------------------------------------------------
// Routes.
// ----------------------------------------------------------------------------

export async function listRoutes(): Promise<AlertRoute[]> {
  return getDb()
    .prepare<[], RouteRow>("SELECT * FROM alert_routes ORDER BY id ASC")
    .all()
    .map(rowToRoute);
}

export async function createRoute(input: {
  scopeType: RouteScopeType;
  scopeValue: string | null;
  channelId: number;
  severities: AlertSeverity[];
}): Promise<AlertRoute> {
  const scopeValue = input.scopeType === "domain" ? input.scopeValue : null;
  if (input.scopeType === "domain" && !scopeValue) {
    throw new Error("createRoute: a 'domain' route requires a scopeValue");
  }
  const severities = sanitizeSeverities(input.severities);
  if (severities.length === 0) {
    throw new Error("createRoute: at least one severity is required");
  }
  const channel = await getChannel(input.channelId);
  if (!channel) throw new Error("createRoute: channel not found");

  const result = getDb()
    .prepare(
      `INSERT INTO alert_routes (scope_type, scope_value, channel_id, severities_json)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.scopeType, scopeValue, input.channelId, JSON.stringify(severities));
  const row = getDb()
    .prepare<[number], RouteRow>("SELECT * FROM alert_routes WHERE id = ?")
    .get(Number(result.lastInsertRowid));
  if (!row) throw new Error("createRoute: insert did not round-trip");
  return rowToRoute(row);
}

export async function deleteRoute(id: number): Promise<boolean> {
  const result = getDb().prepare("DELETE FROM alert_routes WHERE id = ?").run(id);
  return result.changes > 0;
}

// ----------------------------------------------------------------------------
// Resolution.
// ----------------------------------------------------------------------------

/**
 * Effective routes for a domain under the OVERRIDE model: per-domain routes
 * fully replace the defaults when present; otherwise the 'all' routes apply.
 * Pure over a pre-loaded route set so the monitor tick resolves every domain
 * from a single query.
 */
export function effectiveRoutesForDomain(
  domain: string,
  routes: AlertRoute[],
): AlertRoute[] {
  const perDomain = routes.filter(
    (r) => r.scopeType === "domain" && r.scopeValue === domain,
  );
  if (perDomain.length > 0) return perDomain;
  return routes.filter((r) => r.scopeType === "all");
}

/** Convenience loader for the monitor tick and API: channels + routes in one go. */
export async function loadAlertingConfig(): Promise<{
  channels: AlertChannel[];
  routes: AlertRoute[];
}> {
  const [channels, routes] = await Promise.all([listChannels(), listRoutes()]);
  return { channels, routes };
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  AlertChannel,
  AlertChannelType,
  AlertRoute,
  AlertSeverity,
  SmtpChannelConfig,
  WebhookChannelConfig,
} from "@/lib/alert-config";

// Native <select> styled to match the Input primitive's look — no shadcn
// Select primitive in the project, and adding one for two pickers isn't worth
// the dependency churn.
const SELECT_CLS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30";

const ALL_SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];

function channelSummary(channel: AlertChannel): string {
  if (channel.type === "smtp") {
    const c = channel.config as SmtpChannelConfig;
    return `${c.from} → ${c.to.length} recipient${c.to.length === 1 ? "" : "s"}`;
  }
  const c = channel.config as WebhookChannelConfig;
  return c.url;
}

export function AlertsManager() {
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [routes, setRoutes] = useState<AlertRoute[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/alerts");
      if (!r.ok) throw new Error("Failed to load alert configuration");
      const data = await r.json();
      setChannels(data.channels ?? []);
      setRoutes(data.routes ?? []);
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function callApi(payload: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
    try {
      const r = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        return { ok: false, message: d?.message || `HTTP ${r.status}` };
      }
      await load();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  }

  async function toggleChannelEnabled(channel: AlertChannel) {
    const result = await callApi({
      action: "update_channel",
      id: channel.id,
      enabled: !channel.enabled,
    });
    if (!result.ok) setError(result.message ?? "Update failed");
  }

  async function handleDeleteChannel(id: number) {
    if (!confirm("Delete this channel? Its routes will be removed too.")) return;
    const result = await callApi({ action: "delete_channel", id });
    if (!result.ok) setError(result.message ?? "Delete failed");
  }

  async function handleDeleteRoute(id: number) {
    if (!confirm("Delete this route?")) return;
    const result = await callApi({ action: "delete_route", id });
    if (!result.ok) setError(result.message ?? "Delete failed");
  }

  const defaultRoutes = routes.filter((r) => r.scopeType === "all");
  const channelsById = new Map(channels.map((c) => [c.id, c]));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Alerts</h1>
        <p className="text-sm text-muted-foreground">
          Channels deliver alerts; routes pick which severities go where. A
          domain&apos;s own routes override the defaults; otherwise the defaults
          below apply.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            SMTP and webhook destinations. SMTP credentials come from{" "}
            <code className="font-mono">DIVE_SMTP_*</code> env vars; the channel
            holds only routing data.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-end">
            <AddChannelDialog onSubmit={callApi} />
          </div>
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="uppercase text-xs text-muted-foreground">
                      {c.type}
                    </TableCell>
                    <TableCell className="max-w-75 truncate text-sm text-muted-foreground" title={channelSummary(c)}>
                      {channelSummary(c)}
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => toggleChannelEnabled(c)}
                        className={cn(
                          "rounded-md px-2 py-0.5 text-xs font-medium",
                          c.enabled
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {c.enabled ? "Enabled" : "Disabled"}
                      </button>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => handleDeleteChannel(c.id)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {loaded && channels.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      No channels yet. Add one to start receiving alerts.
                    </TableCell>
                  </TableRow>
                ) : null}
                {!loaded ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default routes</CardTitle>
          <CardDescription>
            Apply to every domain that doesn&apos;t have routes of its own. Set
            per-domain overrides on a domain&apos;s detail page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-end">
            <AddRouteDialog channels={channels} onSubmit={callApi} />
          </div>
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead>Severities</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {defaultRoutes.map((r) => {
                  const channel = channelsById.get(r.channelId);
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="font-medium">{channel?.name ?? "(deleted)"}</div>
                        {channel ? (
                          <div className="text-xs text-muted-foreground">
                            {channel.type} · {channelSummary(channel)}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {r.severities.map((s) => (
                            <span
                              key={s}
                              className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium uppercase text-muted-foreground"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10"
                          onClick={() => handleDeleteRoute(r.id)}
                        >
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {loaded && defaultRoutes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                      No default routes. Without one, alerts compute but don&apos;t dispatch.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ===========================================================================
// Add Channel
// ===========================================================================

function AddChannelDialog({
  onSubmit,
}: {
  onSubmit: (payload: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<AlertChannelType>("smtp");
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [toCsv, setToCsv] = useState("");
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState("POST");
  const [headersJson, setHeadersJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function reset() {
    setType("smtp");
    setName("");
    setFrom("");
    setToCsv("");
    setUrl("");
    setMethod("POST");
    setHeadersJson("");
    setErr("");
  }

  async function submit() {
    setErr("");
    if (!name.trim()) return setErr("Name is required.");
    let config: SmtpChannelConfig | WebhookChannelConfig;
    if (type === "smtp") {
      if (!from.trim()) return setErr("From address is required.");
      const to = toCsv.split(",").map((s) => s.trim()).filter(Boolean);
      if (to.length === 0) return setErr("At least one recipient is required.");
      config = { from: from.trim(), to };
    } else {
      if (!/^https?:\/\//.test(url.trim())) return setErr("URL must start with http:// or https://");
      let headers: Record<string, string> = {};
      if (headersJson.trim()) {
        try {
          const parsed = JSON.parse(headersJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return setErr("Headers must be a JSON object.");
          }
          headers = parsed as Record<string, string>;
        } catch {
          return setErr("Headers JSON is not valid.");
        }
      }
      config = { url: url.trim(), method: method.trim() || "POST", headers };
    }

    setBusy(true);
    const result = await onSubmit({
      action: "create_channel",
      type,
      name: name.trim(),
      config,
      enabled: true,
    });
    setBusy(false);
    if (!result.ok) {
      setErr(result.message ?? "Failed to create channel.");
      return;
    }
    reset();
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger render={<Button>Add Channel</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a channel</DialogTitle>
          <DialogDescription>
            A channel is where alerts go. Routes (default or per-domain) decide
            which severities reach it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            <select
              className={SELECT_CLS}
              value={type}
              onChange={(e) => setType(e.target.value as AlertChannelType)}
              disabled={busy}
            >
              <option value="smtp">SMTP (email)</option>
              <option value="webhook">Webhook (HTTP POST)</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input
              placeholder="Ops email"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>
          {type === "smtp" ? (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">From</label>
                <Input
                  type="email"
                  placeholder="alerts@your-domain.com"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  To (comma-separated)
                </label>
                <Input
                  placeholder="ops@your-domain.com, security@your-domain.com"
                  value={toCsv}
                  onChange={(e) => setToCsv(e.target.value)}
                  disabled={busy}
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">URL</label>
                <Input
                  placeholder="https://hooks.slack.com/services/..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Method</label>
                <Input
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Custom headers (optional JSON)
                </label>
                <textarea
                  className="h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                  placeholder='{"X-Auth-Token": "..."}'
                  value={headersJson}
                  onChange={(e) => setHeadersJson(e.target.value)}
                  disabled={busy}
                />
              </div>
            </>
          )}
          {err ? (
            <p className="text-sm text-destructive" role="alert">
              {err}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={submit} disabled={busy}>
            {busy ? "Adding…" : "Add channel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// Add Default Route
// ===========================================================================

function AddRouteDialog({
  channels,
  onSubmit,
}: {
  channels: AlertChannel[];
  onSubmit: (payload: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [open, setOpen] = useState(false);
  // `picked === null` means "fall back to the first channel" — kept derived
  // rather than mirrored via useEffect so the channel list mutating doesn't
  // trigger cascading renders.
  const [picked, setPicked] = useState<number | null>(null);
  const channelId = picked ?? channels[0]?.id ?? null;
  const [severities, setSeverities] = useState<Set<AlertSeverity>>(
    new Set(["warning", "critical"]),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function toggleSeverity(s: AlertSeverity) {
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function submit() {
    setErr("");
    if (channelId === null) return setErr("Pick a channel.");
    if (severities.size === 0) return setErr("Pick at least one severity.");

    setBusy(true);
    const result = await onSubmit({
      action: "create_route",
      scopeType: "all",
      scopeValue: null,
      channelId,
      severities: Array.from(severities),
    });
    setBusy(false);
    if (!result.ok) {
      setErr(result.message ?? "Failed to add route.");
      return;
    }
    setOpen(false);
    setSeverities(new Set(["warning", "critical"]));
  }

  const disabled = channels.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setErr("");
      }}
    >
      <DialogTrigger
        render={<Button disabled={disabled}>Add default route</Button>}
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a default route</DialogTitle>
          <DialogDescription>
            Default routes apply to every domain that doesn&apos;t define its
            own routes.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Channel</label>
            <select
              className={SELECT_CLS}
              value={channelId ?? ""}
              onChange={(e) => setPicked(Number(e.target.value))}
              disabled={busy || disabled}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Severities</div>
            <div className="flex gap-3">
              {ALL_SEVERITIES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={severities.has(s)}
                    onChange={() => toggleSeverity(s)}
                    disabled={busy}
                    className="size-4"
                  />
                  <span className="capitalize">{s}</span>
                </label>
              ))}
            </div>
          </div>
          {err ? (
            <p className="text-sm text-destructive" role="alert">
              {err}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={submit} disabled={busy || disabled}>
            {busy ? "Adding…" : "Add route"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { AlertChannel, AlertRoute, AlertSeverity } from "@/lib/alert-config";

const SELECT_CLS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30";

const ALL_SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];

/**
 * Per-domain alert routing for a single domain — sits on the domain detail
 * page. Under the override model (alert-config.ts), the routes shown here, if
 * any, fully replace the defaults for this one domain. Fetches /api/alerts
 * independently of the detail page's other loads so its mutations don't
 * trigger a re-snapshot.
 */
export function RoutingSection({ domain }: { domain: string }) {
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [routes, setRoutes] = useState<AlertRoute[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/alerts");
      if (!r.ok) throw new Error("Failed to load routing configuration");
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

  async function handleDelete(routeId: number) {
    if (!confirm("Delete this routing rule?")) return;
    const result = await callApi({ action: "delete_route", id: routeId });
    if (!result.ok) setError(result.message ?? "Delete failed");
  }

  const channelsById = new Map(channels.map((c) => [c.id, c]));
  const domainRoutes = routes.filter(
    (r) => r.scopeType === "domain" && r.scopeValue === domain,
  );
  const defaultRoutes = routes.filter((r) => r.scopeType === "all");

  return (
    <Card className="gap-3 p-6">
      <CardHeader className="px-0">
        <CardTitle>Routing</CardTitle>
        <CardDescription>
          {domainRoutes.length > 0
            ? "This domain has its own routes — they replace the defaults for this domain only."
            : "This domain uses the default routes. Add a per-domain route to override them for this domain."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-0">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {domainRoutes.length > 0 ? (
          <div className="flex flex-col gap-2">
            {domainRoutes.map((r) => {
              const ch = channelsById.get(r.channelId);
              return (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{ch?.name ?? "(deleted)"}</div>
                    <div className="text-xs text-muted-foreground">
                      {ch ? ch.type : "—"}
                    </div>
                  </div>
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
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(r.id)}
                  >
                    Delete
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
            {defaultRoutes.length === 0 ? (
              <>
                There are no default routes either. Alerts compute but nothing
                dispatches. Add channels and routes on{" "}
                <Link href="/alerts" className="underline">
                  Alerts
                </Link>
                .
              </>
            ) : (
              <>
                Inheriting {defaultRoutes.length} default route
                {defaultRoutes.length === 1 ? "" : "s"} from{" "}
                <Link href="/alerts" className="underline">
                  Alerts
                </Link>
                .
              </>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <AddPerDomainRouteDialog
            domain={domain}
            channels={channels}
            disabled={!loaded || channels.length === 0}
            onSubmit={callApi}
          />
        </div>

        {channels.length === 0 && loaded ? (
          <p className="text-xs text-muted-foreground">
            No channels exist yet. Add one on{" "}
            <Link href="/alerts" className="underline">
              Alerts
            </Link>{" "}
            before creating a per-domain route.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AddPerDomainRouteDialog({
  domain,
  channels,
  disabled,
  onSubmit,
}: {
  domain: string;
  channels: AlertChannel[];
  disabled: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [open, setOpen] = useState(false);
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
      scopeType: "domain",
      scopeValue: domain,
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

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setErr("");
      }}
    >
      <DialogTrigger render={<Button disabled={disabled}>Add route</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a per-domain route</DialogTitle>
          <DialogDescription>
            This route applies only to <strong>{domain}</strong>. Adding any
            per-domain route makes this domain stop inheriting the defaults.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Channel</label>
            <select
              className={SELECT_CLS}
              value={channelId ?? ""}
              onChange={(e) => setPicked(Number(e.target.value))}
              disabled={busy}
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
          <Button onClick={submit} disabled={busy}>
            {busy ? "Adding…" : "Add route"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

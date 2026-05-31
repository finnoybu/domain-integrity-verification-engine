"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { GlobalSettingKey, GlobalSettingView } from "@/lib/settings";

const LABELS: Record<GlobalSettingKey, { title: string; description: string; unit: string }> = {
  monitor_interval_seconds: {
    title: "Monitor interval",
    description:
      "How often the monitor tick re-checks each domain by default. Per-domain overrides on a domain's detail page beat this for that one domain.",
    unit: "seconds",
  },
  snapshot_retention: {
    title: "Snapshot retention",
    description:
      "Maximum snapshots kept on disk per domain. Older snapshots are deleted on the next successful snapshot. Minimum 2 — the diff engine needs the prior snapshot.",
    unit: "snapshots",
  },
  ownership_lookup_timeout_ms: {
    title: "TXT lookup timeout",
    description:
      "How long the ownership check waits for the TXT response before marking the lookup failed. A failure here counts toward the three-strikes ownership rule.",
    unit: "milliseconds",
  },
};

function sourceBadge(source: GlobalSettingView["source"]) {
  switch (source) {
    case "db":
      return (
        <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          Set in dashboard
        </span>
      );
    case "env":
      return (
        <span className="inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          From env var
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          Default
        </span>
      );
  }
}

export function SettingsManager() {
  const [views, setViews] = useState<GlobalSettingView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings");
      if (!r.ok) throw new Error("Failed to load settings");
      const data = await r.json();
      setViews(data.globals ?? []);
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
      const r = await fetch("/api/settings", {
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

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Global defaults that govern the monitor. A value set here overrides
          the corresponding environment variable; clearing it falls back to
          the env, then to the built-in default.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!loaded ? (
        <Card className="px-6 py-10 text-center text-sm text-muted-foreground">
          Loading…
        </Card>
      ) : null}

      {views.map((view) => (
        <SettingCard key={view.key} view={view} onSubmit={callApi} />
      ))}
    </div>
  );
}

function SettingCard({
  view,
  onSubmit,
}: {
  view: GlobalSettingView;
  onSubmit: (payload: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
}) {
  const labels = LABELS[view.key];
  const [value, setValue] = useState(String(view.effective));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  // Keep input in sync when the upstream value changes (after save / reset).
  // Compare against the stringified current value so user edits aren't clobbered
  // mid-typing.
  const upstream = String(view.effective);
  const [lastUpstream, setLastUpstream] = useState(upstream);
  if (upstream !== lastUpstream) {
    setLastUpstream(upstream);
    setValue(upstream);
  }

  async function save() {
    setErr("");
    const n = Number(value);
    if (!Number.isInteger(n) || n < view.min || n > view.max) {
      setErr(`Value must be an integer in [${view.min}, ${view.max}].`);
      return;
    }
    setBusy(true);
    const r = await onSubmit({ action: "set_global", key: view.key, value: n });
    setBusy(false);
    if (!r.ok) {
      setErr(r.message ?? "Save failed.");
      return;
    }
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }

  async function reset() {
    if (!confirm("Clear the dashboard override and fall back to the env / default?")) return;
    setErr("");
    setBusy(true);
    const r = await onSubmit({ action: "clear_global", key: view.key });
    setBusy(false);
    if (!r.ok) setErr(r.message ?? "Reset failed.");
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{labels.title}</CardTitle>
          {sourceBadge(view.source)}
        </div>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-3">
          <Input
            type="number"
            value={value}
            min={view.min}
            max={view.max}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            className="max-w-48"
          />
          <span className="text-sm text-muted-foreground">{labels.unit}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Range {view.min}–{view.max} · default {view.defaultValue} · env{" "}
          <code className="font-mono">{view.envVar}</code>
        </div>
        {err ? (
          <p className="text-sm text-destructive" role="alert">
            {err}
          </p>
        ) : null}
        {savedFlash ? (
          <p className={cn("text-sm text-emerald-600 dark:text-emerald-400")} role="status">
            Saved.
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={reset}
          disabled={busy || view.source !== "db"}
          title={view.source !== "db" ? "Nothing to reset — already using env / default." : undefined}
        >
          Reset to env / default
        </Button>
        <Button size="sm" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </CardFooter>
    </Card>
  );
}

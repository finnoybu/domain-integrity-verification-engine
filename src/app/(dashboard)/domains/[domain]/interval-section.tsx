"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DomainSettingKey, GlobalSettingView } from "@/lib/settings";

/**
 * Per-domain monitor-interval override for a single domain. Reads
 * /api/settings?domain=…, lets the operator set or clear a per-domain value,
 * and shows the effective interval with provenance. When no override exists
 * the domain inherits the global default (configured on /settings).
 */
export function IntervalSection({ domain }: { domain: string }) {
  const [globalView, setGlobalView] = useState<GlobalSettingView | null>(null);
  const [override, setOverride] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/settings?domain=${encodeURIComponent(domain)}`);
      if (!r.ok) throw new Error("Failed to load schedule settings");
      const data = await r.json();
      const view: GlobalSettingView | undefined = (data.globals ?? []).find(
        (g: GlobalSettingView) => g.key === "monitor_interval_seconds",
      );
      const ds = (data.domainSettings ?? {}) as Record<DomainSettingKey, number | null>;
      const o = ds.monitor_interval_seconds ?? null;
      setGlobalView(view ?? null);
      setOverride(o);
      setValue(String(o ?? view?.effective ?? 3600));
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoaded(true);
    }
  }, [domain]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setError("");
    if (!globalView) return;
    const n = Number(value);
    if (!Number.isInteger(n) || n < globalView.min || n > globalView.max) {
      setError(`Value must be an integer in [${globalView.min}, ${globalView.max}].`);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_domain",
          domain,
          key: "monitor_interval_seconds",
          value: n,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setError(d?.message || "Save failed.");
        return;
      }
      await load();
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setBusy(false);
    }
  }

  async function clearOverride() {
    if (!confirm("Stop using a per-domain interval for this domain? It will inherit the global default.")) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "clear_domain",
          domain,
          key: "monitor_interval_seconds",
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setError(d?.message || "Clear failed.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const effective = override ?? globalView?.effective ?? null;

  return (
    <Card className="gap-3 p-6">
      <CardHeader className="px-0">
        <CardTitle>Check interval</CardTitle>
        <CardDescription>
          {override !== null
            ? "This domain uses its own check interval, overriding the global default."
            : "This domain uses the global default. Set a per-domain override below."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-0">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {!loaded ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                value={value}
                min={globalView?.min}
                max={globalView?.max}
                onChange={(e) => setValue(e.target.value)}
                disabled={busy}
                className="max-w-48"
              />
              <span className="text-sm text-muted-foreground">seconds</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Effective: <strong className="text-foreground">{effective ?? "—"}s</strong>{" "}
              ·{" "}
              {override !== null ? (
                <>per-domain override</>
              ) : (
                <>
                  inheriting the global default ({globalView?.source ?? "—"} ·{" "}
                  <Link href="/settings" className="underline">
                    change on Settings
                  </Link>
                  )
                </>
              )}
              {globalView ? (
                <>
                  {" "}· range {globalView.min}–{globalView.max}
                </>
              ) : null}
            </div>
            {savedFlash ? (
              <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
                Saved.
              </p>
            ) : null}
            <div className="flex justify-between gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={clearOverride}
                disabled={busy || override === null}
                title={override === null ? "Nothing to clear — already inheriting the global default." : undefined}
              >
                Use the global default
              </Button>
              <Button size="sm" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

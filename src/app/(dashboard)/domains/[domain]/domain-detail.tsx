"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SEVERITY_COLORS } from "@/lib/severity";
import type {
  DiffEntry,
  DomainData,
  HistorySnapshot,
  SnapshotApiResponse,
  StatusResult,
  StatusSignal,
} from "../types";
import { RoutingSection } from "./routing-section";

export function DomainDetail({ domain }: { domain: string }) {
  const router = useRouter();
  const [domainData, setDomainData] = useState<DomainData | null>(null);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const [diff, setDiff] = useState<DiffEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch this domain's record from the list endpoint (the only source of
  // ownership + verificationRecord + active), then run the same load sequence
  // the old dashboard ran on domain-select: auto-snapshot an active+verified
  // domain, then pull status / history / diff. Frozen domains skip the
  // snapshot but still show their last data; unverified ones show only the
  // verification panel.
  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const listResponse = await fetch("/api/snapshot");
      if (!listResponse.ok) throw new Error("Failed to load domain");
      const data: SnapshotApiResponse = await listResponse.json();
      const record = (data.domains ?? []).find((d) => d.domain === domain) ?? null;
      setDomainData(record);
      if (!record) {
        setNotFound(true);
        return;
      }

      const isFrozen = !record.active;
      const isUnverified =
        !!record.ownership && record.ownership.state !== "ownership_verified";

      if (isUnverified) {
        setStatus(null);
        setHistory([]);
        setDiff([]);
        return;
      }

      if (!isFrozen) {
        const snapResponse = await fetch("/api/snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain }),
        });
        if (!snapResponse.ok) {
          const errData = await snapResponse.json().catch(() => null);
          throw new Error(errData?.message || "Failed to create snapshot");
        }
        const latestResponse = await fetch(
          `/api/snapshot/latest?domain=${encodeURIComponent(domain)}`,
        );
        if (latestResponse.ok) {
          const latest = await latestResponse.json();
          setDomainData((prev) => (prev ? { ...prev, snapshot: latest } : prev));
        }
      }

      const [statusData, historyData, diffData] = await Promise.all([
        fetch(`/api/status?domain=${encodeURIComponent(domain)}`).then((r) =>
          r.ok ? r.json() : null,
        ),
        fetch(`/api/history?domain=${encodeURIComponent(domain)}`).then((r) =>
          r.ok ? r.json() : null,
        ),
        fetch(`/api/diff?domain=${encodeURIComponent(domain)}`).then((r) =>
          r.ok ? r.json() : null,
        ),
      ]);
      if (statusData) setStatus(statusData);
      if (historyData) setHistory(historyData.snapshots ?? []);
      if (diffData) setDiff(diffData);
    } catch (err) {
      setError(String(err));
      // A snapshot-time failure may have advanced the ownership three-strikes
      // counter server-side. Refresh the record so the verification panel
      // renders if the state flipped to failed.
      try {
        const refresh = await fetch("/api/snapshot");
        if (refresh.ok) {
          const data: SnapshotApiResponse = await refresh.json();
          setDomainData(
            (data.domains ?? []).find((d) => d.domain === domain) ?? null,
          );
        }
      } catch {
        /* best effort */
      }
    } finally {
      setLoading(false);
    }
  }, [domain]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  async function handleVerify() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, action: "verify" }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        setError(errData?.message || "Verification failed");
        setLoading(false);
        return;
      }
      // Server took the first snapshot on success — reload the full detail.
      await loadDetail();
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  async function handleCopyToken(token: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(token);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = token;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!ok) throw new Error("copy command rejected by browser");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Copy failed: ${err.message}. Select and copy the token manually.`
          : "Copy failed. Select and copy the token manually.",
      );
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete ${domain}?`)) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, action: "delete" }),
      });
      if (!response.ok) throw new Error("Failed to delete domain");
      router.push("/domains");
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  const snapshot = domainData?.snapshot;
  const ownership = domainData?.ownership;
  const isFrozen = domainData ? !domainData.active : false;
  const needsVerification =
    !!ownership && ownership.state !== "ownership_verified";

  const groupedSignals = (status?.signals ?? []).reduce(
    (acc, signal) => {
      (acc[signal.severity] ??= []).push(signal);
      return acc;
    },
    {} as Record<string, StatusSignal[]>,
  );

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/domains"
            className="text-sm text-muted-foreground hover:underline"
          >
            ← Domains
          </Link>
          <h1 className="truncate text-2xl font-semibold">{domain}</h1>
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <span className="text-sm text-muted-foreground">Loading…</span>
          ) : null}
          {domainData ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              disabled={loading}
              className="text-destructive hover:bg-destructive/10"
            >
              Delete
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {notFound ? (
        <Card className="px-6 py-10 text-center text-sm text-muted-foreground">
          Domain not found. It may have been deleted.{" "}
          <Link href="/domains" className="underline">
            Back to Domains
          </Link>
          .
        </Card>
      ) : null}

      {/* Ownership verification panel */}
      {needsVerification && ownership ? (
        <Card
          className="gap-3 border-l-4 p-6"
          style={{
            borderLeftColor:
              ownership.state === "ownership_failed"
                ? SEVERITY_COLORS.critical
                : "#3b82f6",
          }}
        >
          <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {ownership.state === "ownership_failed"
              ? "Ownership verification failed"
              : "Ownership verification required"}
          </div>
          <h2 className="text-xl font-semibold">
            Publish the verification record for {domain}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            DIVE proves control of every monitored domain on every check.
            Publish a TXT record at the name below containing the issued token,
            then click <strong>Verify</strong>. The first snapshot runs as soon
            as the record is found.
          </p>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
            <span className="font-medium text-muted-foreground">Record type</span>
            <code className="rounded bg-muted px-2 py-1 font-mono">TXT</code>
            <span className="font-medium text-muted-foreground">Name</span>
            <code className="break-all rounded bg-muted px-2 py-1 font-mono">
              {domainData?.verificationRecord}
            </code>
            <span className="font-medium text-muted-foreground">Value</span>
            <code className="break-all rounded bg-muted px-2 py-1 font-mono">
              {ownership.token}
            </code>
          </div>
          {ownership.state === "ownership_failed" ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {ownership.consecutiveFailures} consecutive ownership checks have
              failed. Re-publish the TXT record and verify to resume monitoring.
            </div>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button size="lg" onClick={handleVerify} disabled={loading}>
              {loading ? "Verifying…" : "Verify"}
            </Button>
            <Button
              size="lg"
              variant={copied ? "secondary" : "outline"}
              onClick={() => handleCopyToken(ownership.token)}
            >
              {copied ? "Copied!" : "Copy token"}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Snapshot detail */}
      {snapshot && status ? (
        <>
          {isFrozen ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
              This domain is <strong>frozen</strong> — beyond your licensed
              capacity. Monitoring is paused; the data below reflects the last
              snapshot, from {new Date(snapshot.timestamp).toLocaleString()}.
            </div>
          ) : null}

          {/* Status banner */}
          <StatusBanner status={status} timestamp={snapshot.timestamp} />

          {/* Active signals */}
          {status.domain_state === "valid" &&
          status.stability_state !== "baseline" &&
          status.signals &&
          status.signals.length > 0 ? (
            <Card className="gap-3 p-6">
              <h2 className="text-lg font-semibold">Active Signals</h2>
              <div className="flex flex-col gap-2">
                {(["critical", "risk", "drift", "stable"] as const).flatMap(
                  (severity) =>
                    (groupedSignals[severity] ?? []).map((signal, idx) => (
                      <div
                        key={`${severity}-${idx}`}
                        className="flex items-center gap-3 rounded-md border-l-4 bg-muted/40 p-3"
                        style={{ borderLeftColor: SEVERITY_COLORS[severity] }}
                      >
                        <span
                          className="inline-block min-w-[72px] rounded px-2 py-0.5 text-center text-xs font-bold uppercase tracking-wide text-white"
                          style={{ backgroundColor: SEVERITY_COLORS[severity] }}
                        >
                          {severity}
                        </span>
                        <div className="flex-1">
                          <div className="font-medium">
                            {signal.rule.replace(/_/g, " ")}
                          </div>
                          <div className="mt-0.5 text-sm text-muted-foreground">
                            {signal.path || "N/A"}
                            {signal.days_remaining !== undefined ? (
                              <span className="ml-2">
                                ({signal.days_remaining} days remaining)
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )),
                )}
              </div>
            </Card>
          ) : null}

          {/* Snapshot timeline */}
          <Card className="gap-3 p-6">
            <h2 className="text-lg font-semibold">Snapshot Timeline</h2>
            <div className="flex flex-col gap-2">
              {history.map((h, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-md border-l-[3px] bg-muted/40 px-4 py-2"
                  style={{ borderLeftColor: idx === 0 ? "#059669" : "#d1d5db" }}
                >
                  <span className={idx === 0 ? "font-semibold" : "font-medium"}>
                    {idx === 0 ? "Latest" : "Previous"}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {new Date(h.timestamp).toLocaleString()}
                  </span>
                </div>
              ))}
              {history.length === 0 ? (
                <div className="text-sm italic text-muted-foreground">
                  No snapshot history available
                </div>
              ) : null}
              {history.length > 1 &&
              status.domain_state === "valid" &&
              status.stability_state !== "baseline" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-1 self-start"
                  onClick={() => setShowDiff((v) => !v)}
                >
                  {showDiff ? "Hide Changes" : "View Changes"}
                </Button>
              ) : null}
            </div>
          </Card>

          {/* Diff */}
          {showDiff &&
          diff.length > 0 &&
          status.domain_state === "valid" &&
          status.stability_state !== "baseline" ? (
            <Card className="gap-3 p-6">
              <h2 className="text-lg font-semibold">Changes</h2>
              <div className="flex flex-col gap-2">
                {diff
                  .slice()
                  .sort((a, b) => a.path.localeCompare(b.path))
                  .map((d, idx) => (
                    <div
                      key={idx}
                      className="rounded-md border-l-[3px] border-amber-500 bg-amber-500/10 p-3 text-sm"
                    >
                      <div className="mb-1 font-semibold text-amber-700 dark:text-amber-400">
                        {d.path}
                      </div>
                      <div className="grid grid-cols-[auto_1fr] gap-2 text-xs">
                        <span className="font-medium text-destructive">From:</span>
                        <span className="break-words">
                          {Array.isArray(d.from) ? JSON.stringify(d.from) : String(d.from)}
                        </span>
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">
                          To:
                        </span>
                        <span className="break-words">
                          {Array.isArray(d.to) ? JSON.stringify(d.to) : String(d.to)}
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            </Card>
          ) : null}

          {/* Raw JSON */}
          <Card className="gap-3 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Raw Snapshot Data</h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowRawJson((v) => !v)}
              >
                {showRawJson ? "Collapse" : "Expand"}
              </Button>
            </div>
            {showRawJson ? (
              <pre className="max-h-[500px] overflow-auto rounded-md border border-border bg-muted/40 p-4 text-xs">
                {JSON.stringify(snapshot, null, 2)}
              </pre>
            ) : null}
          </Card>
        </>
      ) : null}

      {/* Verified domain with no snapshot yet (rare) */}
      {!snapshot &&
      !needsVerification &&
      !notFound &&
      !loading &&
      domainData ? (
        <Card className="px-6 py-10 text-center text-sm text-muted-foreground">
          No snapshot data available yet.
        </Card>
      ) : null}

      {/* Per-domain alert routing — rendered for any known domain so it's
          configurable before verification too. */}
      {domainData ? <RoutingSection domain={domain} /> : null}
    </div>
  );
}

function StatusBanner({
  status,
  timestamp,
}: {
  status: StatusResult;
  timestamp: string;
}) {
  if (status.domain_state === "invalid") {
    return (
      <Banner color={SEVERITY_COLORS.invalid} label="Invalid Domain">
        Domain could not be resolved or is not registered
      </Banner>
    );
  }
  if (status.stability_state === "baseline") {
    return (
      <Banner color={SEVERITY_COLORS.baseline} label="Baseline" timestamp={timestamp}>
        Initial snapshot captured; no comparison available
      </Banner>
    );
  }
  const key = (status.stability_state ?? "stable") as keyof typeof SEVERITY_COLORS;
  const count = status.signals?.length ?? 0;
  return (
    <Banner
      color={SEVERITY_COLORS[key]}
      label={status.stability_state ?? "stable"}
      timestamp={timestamp}
    >
      {count === 0
        ? "No changes detected"
        : `${count} signal${count !== 1 ? "s" : ""} detected`}
    </Banner>
  );
}

function Banner({
  color,
  label,
  timestamp,
  children,
}: {
  color: string;
  label: string;
  timestamp?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-4 rounded-lg p-6 text-white shadow-sm"
      style={{ backgroundColor: color }}
    >
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide opacity-90">
          Status
        </div>
        <div className="text-3xl font-bold uppercase tracking-tight">{label}</div>
        <div className="mt-1 text-sm opacity-95">{children}</div>
      </div>
      {timestamp ? (
        <div className="text-right text-sm opacity-95">
          <div>Snapshot</div>
          <div className="mt-0.5 font-medium">
            {new Date(timestamp).toLocaleString()}
          </div>
        </div>
      ) : null}
    </div>
  );
}

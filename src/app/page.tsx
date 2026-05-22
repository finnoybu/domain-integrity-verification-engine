"use client";

import { useState, useEffect, useCallback } from "react";
import { DomainSnapshot } from "@/lib/storage";

interface DomainData {
  domain: string;
  snapshot: DomainSnapshot;
  active: boolean;
}

interface LicenseInfo {
  licensed: boolean;
  tier: string | null;
  domainLimit: number;
  expires: string | null;
  expired: boolean;
}

interface StatusSignal {
  rule: string;
  path?: string;
  severity: "stable" | "drift" | "risk" | "critical";
  days_remaining?: number;
}

interface StatusResult {
  domain_state: "invalid" | "valid";
  stability_state?: "baseline" | "stable" | "drift" | "risk" | "critical";
  signals?: StatusSignal[];
}

interface DiffEntry {
  path: string;
  from: string | string[];
  to: string | string[];
}

interface HistorySnapshot {
  domain: string;
  timestamp: string;
}

const SEVERITY_COLORS = {
  stable: "#16A34A",
  drift: "#D97706",
  risk: "#DC2626",
  critical: "#7F1D1D",
  baseline: "#0EA5E9",
  invalid: "#9CA3AF",
};

export default function Home() {
  const [domains, setDomains] = useState<DomainData[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [addingDomain, setAddingDomain] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [error, setError] = useState<string>("");
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const [diff, setDiff] = useState<DiffEntry[]>([]);
  
  const [showDiff, setShowDiff] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);

  // Load domains and license capacity from the API
  const loadDomains = useCallback(async (): Promise<DomainData[]> => {
    try {
      const response = await fetch("/api/snapshot");
      if (!response.ok) throw new Error("Failed to load domains");
      const data = await response.json();
      const domainsList: DomainData[] = data.domains || [];
      setDomains(domainsList);
      setLicense(data.license || null);
      return domainsList;
    } catch (err) {
      setError(String(err));
      return [];
    }
  }, []);

  // Load domains on mount and initialize the selected domain
  useEffect(() => {
    loadDomains().then((domainsList) => {
      if (domainsList.length > 0) {
        setSelectedDomain(domainsList[0].domain);
      }
    });
  }, [loadDomains]);

  async function handleAddDomain() {
    if (!newDomain.trim()) {
      setError("Please enter a domain");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim() }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        setError(errData?.message || "Failed to add domain");
        return;
      }

      const newDomainData = await response.json();
      const addedDomain = newDomainData.domain;
      
      setNewDomain("");
      setAddingDomain(false);
      
      // Add the new domain to the list and select it
      setDomains((prevDomains) => [
        ...prevDomains,
        { domain: addedDomain, snapshot: newDomainData, active: true },
      ]);
      setSelectedDomain(addedDomain);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDomainSelect(domain: string) {
    setSelectedDomain(domain);
    
    if (!domain) return;

    setLoading(true);
    setError("");

    // Frozen domains are beyond the licensed limit — never (re)snapshot them.
    const isFrozen = domains.find((d) => d.domain === domain)?.active === false;

    try {
      if (!isFrozen) {
        // Auto-snapshot on selecting an active domain
        const response = await fetch("/api/snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain }),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => null);
          throw new Error(errData?.message || "Failed to create snapshot");
        }

        // Refresh this domain's snapshot in the list (preserve its active flag)
        const latestResponse = await fetch(`/api/snapshot/latest?domain=${domain}`);
        if (latestResponse.ok) {
          const latestSnapshot = await latestResponse.json();
          setDomains((prevDomains) =>
            prevDomains.map((d) =>
              d.domain === domain ? { ...d, snapshot: latestSnapshot } : d
            )
          );
        }
      }
      
      // Fetch status data
      const statusResponse = await fetch(`/api/status?domain=${domain}`);
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        setStatus(statusData);
      }
      
      // Fetch history data
      const historyResponse = await fetch(`/api/history?domain=${domain}`);
      if (historyResponse.ok) {
        const historyData = await historyResponse.json();
        setHistory(historyData.snapshots || []);
      }
      
      // Fetch diff data
      const diffResponse = await fetch(`/api/diff?domain=${domain}`);
      if (diffResponse.ok) {
        const diffData = await diffResponse.json();
        setDiff(diffData);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteDomain() {
    if (!selectedDomain) return;

    if (!confirm(`Delete ${selectedDomain}?`)) return;

    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: selectedDomain, action: "delete" }),
      });

      if (!response.ok) {
        throw new Error("Failed to delete domain");
      }

      // Reload so capacity and active/frozen flags reflect the freed slot
      await loadDomains();
      setSelectedDomain("");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  const selectedDomainData = domains.find((d) => d.domain === selectedDomain);
  const selectedSnapshot = selectedDomainData?.snapshot;
  const selectedFrozen = selectedDomainData ? !selectedDomainData.active : false;
  const frozenCount = domains.filter((d) => !d.active).length;
  const frozenSentence = frozenCount === 1 ? "1 domain is" : `${frozenCount} domains are`;
  
  // Group signals by severity (descending order: critical, risk, drift, stable)
  const groupedSignals = status?.signals
    ? status.signals.reduce((acc, signal) => {
        const severity = signal.severity;
        if (!acc[severity]) acc[severity] = [];
        acc[severity].push(signal);
        return acc;
      }, {} as Record<string, StatusSignal[]>)
    : {};

  return (
    <div style={{ minHeight: "100vh", fontFamily: "system-ui, sans-serif", padding: "2rem", backgroundColor: "#f9fafb" }}>
      <header style={{ marginBottom: "2rem", borderBottom: "2px solid #e5e7eb", paddingBottom: "1rem", backgroundColor: "white", padding: "1.5rem", borderRadius: "8px" }}>
        <h1 style={{ margin: "0 0 0.5rem 0", fontSize: "2rem", fontWeight: "600" }}>
          Domain Integrity Engine
        </h1>
        <p style={{ margin: "0", color: "#6b7280", fontSize: "0.95rem" }}>
          Domain governance dashboard for integrity monitoring and snapshot management
        </p>
      </header>

      <main style={{ maxWidth: "1400px", margin: "0 auto" }}>
        {error && (
          <div
            style={{
              padding: "1rem",
              backgroundColor: "#fee2e2",
              color: "#991b1b",
              borderRadius: "6px",
              marginBottom: "1rem",
              border: "1px solid #fecaca",
            }}
          >
            Error: {error}
          </div>
        )}

        {license && (frozenCount > 0 || license.expired) && (
          <div
            style={{
              padding: "1rem",
              backgroundColor: "#fef3c7",
              color: "#92400e",
              borderRadius: "6px",
              marginBottom: "1rem",
              border: "1px solid #f59e0b",
              fontSize: "0.9rem",
            }}
          >
            {license.expired
              ? `Your ${license.tier ?? "license"} expired on ${license.expires}. DIVE reverted to the Free tier (${license.domainLimit}-domain limit).${frozenCount > 0 ? ` ${frozenSentence} now frozen.` : ""}`
              : `${frozenSentence} frozen — beyond the ${license.licensed ? (license.tier ?? "current") : "Free"} tier limit of ${license.domainLimit} domains. Frozen domains keep their last snapshot and resume monitoring when capacity is restored: add or renew a license, or delete a domain.`}
          </div>
        )}

        {license && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
              marginBottom: "0.75rem",
              fontSize: "0.875rem",
              color: frozenCount > 0 ? "#92400e" : "#6b7280",
            }}
          >
            <span style={{ fontWeight: 600 }}>
              {domains.length} / {license.domainLimit} domains
            </span>
            <span>·</span>
            <span>{license.licensed ? (license.tier ?? "Licensed") : "Free tier"}</span>
            {license.licensed && license.expires && (
              <>
                <span>·</span>
                <span>expires {license.expires}</span>
              </>
            )}
            {frozenCount > 0 && (
              <>
                <span>·</span>
                <span style={{ fontWeight: 600 }}>{frozenCount} frozen</span>
              </>
            )}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: "1rem",
            marginBottom: "2rem",
            flexWrap: "wrap",
            alignItems: "center",
            backgroundColor: "white",
            padding: "1.25rem",
            borderRadius: "8px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          }}
        >
          <select
            value={selectedDomain}
            onChange={(e) => handleDomainSelect(e.target.value)}
            style={{
              padding: "0.625rem",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              fontSize: "1rem",
              minWidth: "250px",
              backgroundColor: "white",
            }}
            disabled={domains.length === 0}
          >
            <option value="">
              {domains.length === 0 ? "No domains" : "Select Domain"}
            </option>
            {domains
              .slice()
              .sort((a, b) => a.domain.localeCompare(b.domain))
              .map((d) => (
                <option key={d.domain} value={d.domain}>
                  {d.domain}{d.active ? "" : " — frozen"}
                </option>
              ))}
          </select>

          <button
            onClick={() => setAddingDomain(!addingDomain)}
            style={{
              padding: "0.625rem 1.25rem",
              backgroundColor: "#059669",
              color: "white",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.95rem",
              fontWeight: "500",
            }}
            disabled={addingDomain}
          >
            Add Domain
          </button>

          <button
            onClick={handleDeleteDomain}
            style={{
              padding: "0.625rem 1.25rem",
              backgroundColor: "#dc2626",
              color: "white",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.95rem",
              fontWeight: "500",
            }}
            disabled={!selectedDomain || loading}
          >
            Delete Domain
          </button>
          
          {loading && (
            <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>Loading...</span>
          )}
        </div>

        {addingDomain && (
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              marginBottom: "2rem",
              backgroundColor: "white",
              padding: "1.25rem",
              borderRadius: "8px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
            }}
          >
            <input
              type="text"
              placeholder="example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleAddDomain()}
              autoFocus
              style={{
                padding: "0.625rem",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                fontSize: "1rem",
                flex: 1,
                maxWidth: "350px",
              }}
              disabled={loading}
            />
            <button
              onClick={handleAddDomain}
              style={{
                padding: "0.625rem 1.25rem",
                backgroundColor: "#059669",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
                fontWeight: "500",
              }}
              disabled={loading}
            >
              Add
            </button>
            <button
              onClick={() => {
                setAddingDomain(false);
                setNewDomain("");
              }}
              style={{
                padding: "0.625rem 1.25rem",
                backgroundColor: "#6b7280",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
                fontWeight: "500",
              }}
              disabled={loading}
            >
              Cancel
            </button>
          </div>
        )}

        {selectedSnapshot && status && (
          <>
            {selectedFrozen && (
              <div
                style={{
                  padding: "1rem",
                  backgroundColor: "#fef3c7",
                  color: "#92400e",
                  borderRadius: "6px",
                  marginBottom: "1.5rem",
                  border: "1px solid #f59e0b",
                  fontSize: "0.9rem",
                }}
              >
                This domain is <strong>frozen</strong> — beyond your licensed
                capacity. Monitoring is paused; the dashboard below shows the
                last snapshot, from {new Date(selectedSnapshot.timestamp).toLocaleString()}.
              </div>
            )}

            {/* Invalid Domain Block */}
            {status.domain_state === "invalid" && (
              <div
                style={{
                  padding: "1.5rem",
                  backgroundColor: SEVERITY_COLORS.invalid,
                  color: "white",
                  borderRadius: "8px",
                  marginBottom: "1.5rem",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
                  <div>
                    <div style={{ fontSize: "0.75rem", fontWeight: "600", letterSpacing: "0.05em", marginBottom: "0.5rem", opacity: 0.9 }}>
                      STATUS
                    </div>
                    <div style={{ fontSize: "2rem", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.025em" }}>
                      INVALID DOMAIN
                    </div>
                    <div style={{ fontSize: "0.9rem", marginTop: "0.5rem", opacity: 0.95 }}>
                      Domain could not be resolved or is not registered
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Baseline State Block */}
            {status.domain_state === "valid" && status.stability_state === "baseline" && (
              <div
                style={{
                  padding: "1.5rem",
                  backgroundColor: SEVERITY_COLORS.baseline,
                  color: "white",
                  borderRadius: "8px",
                  marginBottom: "1.5rem",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
                  <div>
                    <div style={{ fontSize: "0.75rem", fontWeight: "600", letterSpacing: "0.05em", marginBottom: "0.5rem", opacity: 0.9 }}>
                      STATUS
                    </div>
                    <div style={{ fontSize: "2rem", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.025em" }}>
                      BASELINE
                    </div>
                    <div style={{ fontSize: "0.9rem", marginTop: "0.5rem", opacity: 0.95 }}>
                      Initial snapshot captured; no comparison available
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: "0.875rem", opacity: 0.95 }}>
                    <div>Baseline snapshot</div>
                    <div style={{ fontWeight: "500", marginTop: "0.25rem" }}>
                      {new Date(selectedSnapshot.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Stability Summary Banner */}
            {status.domain_state === "valid" && status.stability_state !== "baseline" && (
              <div
                style={{
                  padding: "1.5rem",
                  backgroundColor: SEVERITY_COLORS[status.stability_state as keyof typeof SEVERITY_COLORS],
                  color: "white",
                  borderRadius: "8px",
                  marginBottom: "1.5rem",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
                  <div>
                    <div style={{ fontSize: "0.75rem", fontWeight: "600", letterSpacing: "0.05em", marginBottom: "0.5rem", opacity: 0.9 }}>
                      STATUS
                    </div>
                    <div style={{ fontSize: "2rem", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.025em" }}>
                      {status.stability_state}
                    </div>
                    <div style={{ fontSize: "0.9rem", marginTop: "0.5rem", opacity: 0.95 }}>
                      {!status.signals || status.signals.length === 0 ? "No changes detected" : `${status.signals.length} signal${status.signals.length !== 1 ? 's' : ''} detected`}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: "0.875rem", opacity: 0.95 }}>
                    <div>Latest snapshot</div>
                    <div style={{ fontWeight: "500", marginTop: "0.25rem" }}>
                      {new Date(selectedSnapshot.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Active Signals Section - Only show if domain is valid and not baseline */}
            {status.domain_state === "valid" && status.stability_state !== "baseline" && status.signals && status.signals.length > 0 && (
              <div
                style={{
                  backgroundColor: "white",
                  borderRadius: "8px",
                  padding: "1.5rem",
                  marginBottom: "1.5rem",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                }}
              >
                <h2 style={{ margin: "0 0 1rem 0", fontSize: "1.25rem", fontWeight: "600", color: "#111827" }}>
                  Active Signals
                </h2>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {["critical", "risk", "drift", "stable"].map((severity) => {
                    const signals = groupedSignals[severity] || [];
                    if (signals.length === 0) return null;
                    
                    return signals.map((signal, idx) => (
                      <div
                        key={`${severity}-${idx}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "1rem",
                          padding: "0.875rem",
                          backgroundColor: "#f9fafb",
                          borderRadius: "6px",
                          borderLeft: `4px solid ${SEVERITY_COLORS[severity as keyof typeof SEVERITY_COLORS]}`,
                        }}
                      >
                        <span
                          style={{
                            display: "inline-block",
                            padding: "0.25rem 0.625rem",
                            backgroundColor: SEVERITY_COLORS[severity as keyof typeof SEVERITY_COLORS],
                            color: "white",
                            borderRadius: "4px",
                            fontSize: "0.75rem",
                            fontWeight: "700",
                            textTransform: "uppercase",
                            letterSpacing: "0.025em",
                            minWidth: "75px",
                            textAlign: "center",
                          }}
                        >
                          {severity}
                        </span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: "500", color: "#111827" }}>
                            {signal.rule.replace(/_/g, " ")}
                          </div>
                          <div style={{ fontSize: "0.875rem", color: "#6b7280", marginTop: "0.25rem" }}>
                            {signal.path || "N/A"}
                            {signal.days_remaining !== undefined && (
                              <span style={{ marginLeft: "0.5rem" }}>
                                ({signal.days_remaining} days remaining)
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ));
                  })}
                </div>
              </div>
            )}

            {/* Snapshot Timeline Section */}
            <div
              style={{
                backgroundColor: "white",
                borderRadius: "8px",
                padding: "1.5rem",
                marginBottom: "1.5rem",
                boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              }}
            >
              <h2 style={{ margin: "0 0 1rem 0", fontSize: "1.25rem", fontWeight: "600", color: "#111827" }}>
                Snapshot Timeline
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {history.map((h, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: "0.75rem 1rem",
                      backgroundColor: idx === 0 ? "#f0fdf4" : "#f9fafb",
                      borderRadius: "6px",
                      borderLeft: idx === 0 ? "3px solid #059669" : "3px solid #d1d5db",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: idx === 0 ? "600" : "500", color: "#111827" }}>
                        {idx === 0 ? "Latest" : "Previous"}
                      </span>
                      <span style={{ fontSize: "0.875rem", color: "#6b7280" }}>
                        {new Date(h.timestamp).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
                {history.length === 0 && (
                  <div style={{ color: "#6b7280", fontSize: "0.9rem", fontStyle: "italic" }}>
                    No snapshot history available
                  </div>
                )}
                {history.length > 1 && status.domain_state === "valid" && status.stability_state !== "baseline" && (
                  <button
                    onClick={() => setShowDiff(!showDiff)}
                    style={{
                      padding: "0.625rem 1rem",
                      backgroundColor: "#3b82f6",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontSize: "0.875rem",
                      fontWeight: "500",
                      marginTop: "0.5rem",
                    }}
                  >
                    {showDiff ? "Hide Changes" : "View Changes"}
                  </button>
                )}
              </div>
            </div>

            {/* Collapsible Diff View - Only show if domain valid and not baseline */}
            {showDiff && diff.length > 0 && status.domain_state === "valid" && status.stability_state !== "baseline" && (
              <div
                style={{
                  backgroundColor: "white",
                  borderRadius: "8px",
                  padding: "1.5rem",
                  marginBottom: "1.5rem",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                }}
              >
                <h2 style={{ margin: "0 0 1rem 0", fontSize: "1.25rem", fontWeight: "600", color: "#111827" }}>
                  Changes
                </h2>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {diff.sort((a, b) => a.path.localeCompare(b.path)).map((d, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: "0.75rem",
                        backgroundColor: "#fef3c7",
                        borderRadius: "4px",
                        fontSize: "0.875rem",
                        borderLeft: "3px solid #f59e0b",
                      }}
                    >
                      <div style={{ fontWeight: "600", marginBottom: "0.5rem", color: "#92400e" }}>
                        {d.path}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.5rem", fontSize: "0.8125rem" }}>
                        <span style={{ color: "#dc2626", fontWeight: "500" }}>From:</span>
                        <span style={{ wordBreak: "break-word", color: "#7f1d1d" }}>
                          {Array.isArray(d.from) ? JSON.stringify(d.from) : String(d.from)}
                        </span>
                        <span style={{ color: "#059669", fontWeight: "500" }}>To:</span>
                        <span style={{ wordBreak: "break-word", color: "#064e3b" }}>
                          {Array.isArray(d.to) ? JSON.stringify(d.to) : String(d.to)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Collapsible Raw JSON View */}
            <div
              style={{
                backgroundColor: "white",
                borderRadius: "8px",
                padding: "1.5rem",
                marginBottom: "1.5rem",
                boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h2 style={{ margin: "0", fontSize: "1.25rem", fontWeight: "600", color: "#111827" }}>
                  Raw Snapshot Data
                </h2>
                <button
                  onClick={() => setShowRawJson(!showRawJson)}
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#6b7280",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                  }}
                >
                  {showRawJson ? "Collapse" : "Expand"}
                </button>
              </div>
              {showRawJson && (
                <pre
                  style={{
                    backgroundColor: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: "6px",
                    padding: "1rem",
                    overflow: "auto",
                    fontSize: "0.8125rem",
                    maxHeight: "500px",
                    margin: 0,
                  }}
                >
                  {JSON.stringify(selectedSnapshot, null, 2)}
                </pre>
              )}
            </div>
          </>
        )}

        {!selectedSnapshot && selectedDomain && (
          <div style={{ backgroundColor: "white", padding: "2rem", borderRadius: "8px", textAlign: "center", color: "#6b7280" }}>
            <p>No snapshot data available. Select a domain to fetch.</p>
          </div>
        )}

        {!selectedDomain && domains.length > 0 && (
          <div style={{ backgroundColor: "white", padding: "2rem", borderRadius: "8px", textAlign: "center", color: "#6b7280" }}>
            <p>Select a domain from the dropdown to view its stability dashboard.</p>
          </div>
        )}

        {domains.length === 0 && (
          <div style={{ backgroundColor: "white", padding: "3rem", borderRadius: "8px", textAlign: "center" }}>
            <p style={{ color: "#6b7280", fontSize: "1.1rem", margin: 0 }}>
              No domains yet. Click &quot;Add Domain&quot; to get started.
            </p>
          </div>
        )}
      </main>

      <footer
        style={{
          maxWidth: "1400px",
          margin: "2rem auto 0 auto",
          paddingTop: "1rem",
          borderTop: "1px solid #e5e7eb",
          color: "#6b7280",
          fontSize: "0.875rem",
          textAlign: "center",
        }}
      >
        © 2026 Finnoybu IP LLC. Licensed under the Business Source License 1.1.
      </footer>
    </div>
  );
}

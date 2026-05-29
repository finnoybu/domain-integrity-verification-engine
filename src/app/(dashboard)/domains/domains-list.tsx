"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DomainData,
  LicenseInfo,
  OwnershipState,
  SnapshotApiResponse,
} from "./types";

type Filter = "all" | "verified" | "unverified" | "failed" | "frozen";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "verified", label: "Verified" },
  { key: "unverified", label: "Unverified" },
  { key: "failed", label: "Failed" },
  { key: "frozen", label: "Frozen" },
];

function matchesFilter(domain: DomainData, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "frozen":
      return !domain.active;
    case "verified":
      return domain.ownership?.state === "ownership_verified";
    case "unverified":
      return domain.ownership?.state === "ownership_unverified";
    case "failed":
      return domain.ownership?.state === "ownership_failed";
  }
}

function Badge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

function OwnershipBadge({ state }: { state: OwnershipState | undefined }) {
  switch (state) {
    case "ownership_verified":
      return <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">Verified</Badge>;
    case "ownership_failed":
      return <Badge className="bg-destructive/10 text-destructive">Failed</Badge>;
    case "ownership_unverified":
    default:
      return <Badge className="bg-muted text-muted-foreground">Unverified</Badge>;
  }
}

export function DomainsList() {
  const router = useRouter();
  const [domains, setDomains] = useState<DomainData[]>([]);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  // Add-domain dialog state.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/snapshot");
      if (!response.ok) throw new Error("Failed to load domains");
      const data: SnapshotApiResponse = await response.json();
      setDomains(data.domains ?? []);
      setLicense(data.license ?? null);
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

  async function handleAdd() {
    const domain = newDomain.trim().toLowerCase();
    if (!domain) {
      setAddError("Enter a domain.");
      return;
    }
    setAdding(true);
    setAddError("");
    try {
      const response = await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, action: "add" }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setAddError(data?.message || "Failed to add domain.");
        return;
      }
      // Registered (no snapshot yet). Go to its detail page, where the
      // ownership-verification panel walks the operator through the TXT record.
      setDialogOpen(false);
      setNewDomain("");
      router.push(`/domains/${encodeURIComponent(domain)}`);
    } catch (err) {
      setAddError(String(err));
    } finally {
      setAdding(false);
    }
  }

  const frozenCount = domains.filter((d) => !d.active).length;
  const frozenSentence = frozenCount === 1 ? "1 domain is" : `${frozenCount} domains are`;
  const visible = domains.filter((d) => matchesFilter(d, filter));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Domains</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger
            render={<Button>Add Domain</Button>}
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a domain</DialogTitle>
              <DialogDescription>
                DIVE registers the domain and issues an ownership token. Publish
                the TXT challenge and verify on the next screen — no snapshot is
                taken until you do.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Input
                autoFocus
                placeholder="example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAdd();
                }}
                disabled={adding}
              />
              {addError ? (
                <p className="text-sm text-destructive" role="alert">
                  {addError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Cancel</Button>} />
              <Button onClick={handleAdd} disabled={adding}>
                {adding ? "Adding…" : "Add domain"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {license && (frozenCount > 0 || license.expired) ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          {license.expired
            ? `Your ${license.tier ?? "license"} expired on ${license.expires}. DIVE reverted to the Free tier (${license.domainLimit}-domain limit).${frozenCount > 0 ? ` ${frozenSentence} now frozen.` : ""}`
            : `${frozenSentence} frozen — beyond the ${license.licensed ? (license.tier ?? "current") : "Free"} tier limit of ${license.domainLimit} domains. Frozen domains keep their last snapshot and resume monitoring when capacity is restored.`}
        </div>
      ) : null}

      {license ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {domains.length} / {license.domainLimit} domains
          </span>
          <span>·</span>
          <span>{license.licensed ? (license.tier ?? "Licensed") : "Free tier"}</span>
          {license.licensed && license.expires ? (
            <>
              <span>·</span>
              <span>expires {license.expires}</span>
            </>
          ) : null}
          {frozenCount > 0 ? (
            <>
              <span>·</span>
              <span className="font-medium">{frozenCount} frozen</span>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.key
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Ownership</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last snapshot</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((d) => (
              <TableRow key={d.domain}>
                <TableCell>
                  <Link
                    href={`/domains/${encodeURIComponent(d.domain)}`}
                    className="font-medium text-foreground hover:underline"
                  >
                    {d.domain}
                  </Link>
                </TableCell>
                <TableCell>
                  <OwnershipBadge state={d.ownership?.state} />
                </TableCell>
                <TableCell>
                  {d.active ? (
                    <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                      Active
                    </Badge>
                  ) : (
                    <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                      Frozen
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {d.ownership?.state === "ownership_verified" && d.snapshot?.timestamp
                    ? new Date(d.snapshot.timestamp).toLocaleString()
                    : "—"}
                </TableCell>
              </TableRow>
            ))}
            {loaded && visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  {domains.length === 0
                    ? "No domains yet. Click “Add Domain” to get started."
                    : "No domains match this filter."}
                </TableCell>
              </TableRow>
            ) : null}
            {!loaded ? (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

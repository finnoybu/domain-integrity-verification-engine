import type { Metadata } from "next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDomainAccess } from "@/lib/storage";

export const metadata: Metadata = { title: "License — DIVE" };

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-medium">{value}</span>
    </div>
  );
}

/**
 * Read-only license + capacity view. Licenses are provisioned via the
 * DIVE_LICENSE env var / license file (offline Ed25519 verification in
 * src/lib/license.ts), consistent with the rest of DIVE's operator config —
 * there is no in-app key upload, so this page reports rather than edits.
 */
export default async function LicensePage() {
  const access = await getDomainAccess();
  const { license, limit, active, frozen } = access;
  const used = active.length + frozen.length;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-2xl font-semibold">License</h1>

      <Card>
        <CardHeader>
          <CardTitle>
            {license.licensed ? (license.tier ?? "Licensed") : "Free tier"}
          </CardTitle>
          <CardDescription>{license.reason}</CardDescription>
        </CardHeader>
        <CardContent>
          <Row
            label="Status"
            value={
              license.expired
                ? "Expired"
                : license.licensed
                  ? "Active"
                  : "Unlicensed (Free tier)"
            }
          />
          <Row label="Tier" value={license.tier ?? "Free"} />
          {license.customer ? (
            <Row label="Customer" value={license.customer} />
          ) : null}
          <Row label="Domain limit" value={limit} />
          <Row label="Expires" value={license.expires ?? "—"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Capacity</CardTitle>
          <CardDescription>
            {used} of {limit} domains in use
            {frozen.length > 0 ? ` · ${frozen.length} frozen` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Row label="Active" value={active.length} />
          <Row label="Frozen" value={frozen.length} />
          {frozen.length > 0 ? (
            <div className="pt-3 text-sm text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">
                Frozen domains
              </div>
              <ul className="list-inside list-disc space-y-0.5">
                {frozen.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <p className="mt-2">
                Frozen domains keep their last snapshot and resume monitoring
                when capacity is restored — add or renew a license, or delete a
                domain.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Licenses are provisioned via the <code className="font-mono">DIVE_LICENSE</code>{" "}
        environment variable or license file and verified offline. To change
        tiers, update that configuration and restart DIVE.
      </p>
    </div>
  );
}

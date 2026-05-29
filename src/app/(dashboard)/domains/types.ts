import type { DomainSnapshot } from "@/lib/storage";

// Client-side mirrors of the JSON shapes the /api/* routes return. Lifted
// verbatim from the retired single-page dashboard so the list and detail
// components share one definition.

export type OwnershipState =
  | "ownership_unverified"
  | "ownership_verified"
  | "ownership_failed";

export interface OwnershipRecord {
  token: string;
  state: OwnershipState;
  verifiedAt: string | null;
  failedAt: string | null;
  consecutiveFailures: number;
}

export interface DomainData {
  domain: string;
  snapshot: DomainSnapshot;
  ownership: OwnershipRecord | null;
  verificationRecord: string;
  active: boolean;
}

export interface LicenseInfo {
  licensed: boolean;
  tier: string | null;
  domainLimit: number;
  expires: string | null;
  expired: boolean;
}

export interface StatusSignal {
  rule: string;
  path?: string;
  severity: "stable" | "drift" | "risk" | "critical";
  days_remaining?: number;
}

export interface StatusResult {
  domain_state: "invalid" | "valid";
  stability_state?: "baseline" | "stable" | "drift" | "risk" | "critical";
  signals?: StatusSignal[];
}

export interface DiffEntry {
  path: string;
  from: string | string[];
  to: string | string[];
}

export interface HistorySnapshot {
  domain: string;
  timestamp: string;
}

export interface SnapshotApiResponse {
  domains: DomainData[];
  license: LicenseInfo | null;
}

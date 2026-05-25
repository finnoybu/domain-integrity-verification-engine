/**
 * Smoke test for the SQLite migration: opens the DB (triggering the
 * domains.json → SQLite import if applicable), reads back every domain,
 * compares the round-tripped shape against the original JSON. Exits 0 on
 * success, 1 on any divergence — so it's safe to run in CI.
 *
 * Run: `npx tsx scripts/smoke-sqlite-migration.ts`
 *
 * Assumes a backup of the original JSON exists at
 * data/domains.json.backup-pr2 (created before this PR was started). After
 * a successful run, data/domains.json has been renamed to
 * data/domains.json.imported.
 */

import fs from "fs";
import path from "path";
import {
  getDomains,
  getOwnership,
  getDomainSnapshot,
  getLastAlerted,
} from "../src/lib/storage";
import { closeDb } from "../src/lib/db";

const BACKUP = path.join(process.cwd(), "data", "domains.json.backup-pr2");

interface LegacyOwnership {
  token: string;
  state: string;
  verifiedAt: string | null;
  failedAt: string | null;
  consecutiveFailures: number;
}

interface LegacyEntry {
  lastSnapshot: { domain: string };
  ownership: LegacyOwnership;
  lastAlerted?: {
    stabilityState: string | null;
    ownershipState: string | null;
    lastAlertedAt: string | null;
  };
}

interface LegacyStore {
  domains: Record<string, LegacyEntry>;
}

async function main(): Promise<void> {
  if (!fs.existsSync(BACKUP)) {
    console.error(`No backup found at ${BACKUP} — nothing to compare against`);
    process.exit(1);
  }
  const original = JSON.parse(fs.readFileSync(BACKUP, "utf-8")) as LegacyStore;
  const originalDomains = Object.keys(original.domains);

  const round = await getDomains();
  const errors: string[] = [];

  if (round.length !== originalDomains.length) {
    errors.push(
      `domain count mismatch: original=${originalDomains.length} round-trip=${round.length}`,
    );
  }
  // Order matters — license capacity depends on insertion order.
  for (let i = 0; i < Math.min(round.length, originalDomains.length); i++) {
    if (round[i] !== originalDomains[i]) {
      errors.push(`domain order mismatch at index ${i}: original=${originalDomains[i]} round-trip=${round[i]}`);
    }
  }

  for (const name of originalDomains) {
    const orig = original.domains[name];
    const own = await getOwnership(name);
    if (!own) {
      errors.push(`${name}: ownership round-tripped as null`);
      continue;
    }
    if (own.token !== orig.ownership.token)
      errors.push(`${name}: ownership token mismatch`);
    if (own.state !== orig.ownership.state)
      errors.push(`${name}: ownership state ${orig.ownership.state} → ${own.state}`);
    if (own.verifiedAt !== orig.ownership.verifiedAt)
      errors.push(`${name}: ownership verifiedAt mismatch`);
    if (own.failedAt !== orig.ownership.failedAt)
      errors.push(`${name}: ownership failedAt mismatch`);
    if (own.consecutiveFailures !== orig.ownership.consecutiveFailures)
      errors.push(`${name}: ownership consecutiveFailures mismatch`);

    const snap = await getDomainSnapshot(name);
    if (!snap || snap.domain !== name) {
      errors.push(`${name}: last snapshot round-tripped wrong`);
    }

    const alerted = await getLastAlerted(name);
    if (orig.lastAlerted) {
      if (!alerted) errors.push(`${name}: lastAlerted dropped`);
      else if (alerted.lastAlertedAt !== orig.lastAlerted.lastAlertedAt)
        errors.push(`${name}: lastAlertedAt mismatch`);
    }
  }

  closeDb();

  if (errors.length > 0) {
    console.error(`✗ ${errors.length} discrepancy(s) detected:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `✓ migration round-trip OK — ${round.length} domain(s) verified against ${BACKUP}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke test fatal:", err);
  process.exit(1);
});

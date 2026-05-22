#!/usr/bin/env node
/**
 * Mint a signed DIVE license token.
 *
 * Usage:
 *   node scripts/mint-license.mjs --customer <id> --domains <n> [options]
 *
 * Options:
 *   --customer <id>     Customer identifier (email or id). Required.
 *   --domains  <n>      Domain limit for the license. Required.
 *   --tier     <name>   Tier label. Default: "custom-<n>".
 *   --years    <n>      Validity in years from today. Default: 1.
 *   --expires  <date>   Explicit expiry (YYYY-MM-DD). Overrides --years.
 *   --key      <path>   Private key PEM path. Default: license-private-key.pem.
 *
 * Prints the license token. Give it to the customer; they set it as the
 * DIVE_LICENSE environment variable on their DIVE deployment.
 */
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const USAGE =
  "Usage: node scripts/mint-license.mjs --customer <id> --domains <n> " +
  "[--tier <name>] [--years <n> | --expires YYYY-MM-DD] [--key <path>]";

function fail(message) {
  console.error(`Error: ${message}`);
  console.error("");
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (typeof args.customer !== "string" || args.customer === "") {
  fail("--customer <id> is required.");
}

if (typeof args.domains !== "string") {
  fail("--domains <n> is required.");
}
const domainLimit = Number(args.domains);
if (!Number.isInteger(domainLimit) || domainLimit < 1) {
  fail("--domains must be a positive integer.");
}

const keyPath = typeof args.key === "string" ? args.key : "license-private-key.pem";
if (!existsSync(keyPath)) {
  fail(`Private key not found at ${keyPath}. Run: node scripts/license-keys.mjs`);
}

const today = new Date();
const issued = today.toISOString().slice(0, 10);

let expires;
if (typeof args.expires === "string") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.expires)) {
    fail("--expires must be in YYYY-MM-DD form.");
  }
  expires = args.expires;
} else {
  let years = 1;
  if (args.years !== undefined) {
    const parsedYears = Number(args.years);
    if (typeof args.years !== "string" || !Number.isInteger(parsedYears) || parsedYears < 1) {
      fail("--years must be a positive integer.");
    }
    years = parsedYears;
  }
  const expiryDate = new Date(today);
  expiryDate.setUTCFullYear(expiryDate.getUTCFullYear() + years);
  expires = expiryDate.toISOString().slice(0, 10);
}

const tier = typeof args.tier === "string" ? args.tier : `custom-${domainLimit}`;

const payload = {
  v: 1,
  licenseId: `lic_${randomBytes(8).toString("hex")}`,
  customer: args.customer,
  tier,
  domainLimit,
  issued,
  expires,
};

const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
} catch (error) {
  fail(`Could not load the private key from ${keyPath}: ${error.message}`);
}

const signature = sign(null, Buffer.from(payloadB64, "utf8"), privateKey).toString("base64url");
const token = `${payloadB64}.${signature}`;

console.log("");
console.log(`License minted for ${payload.customer}`);
console.log(`  tier:    ${tier}`);
console.log(`  domains: ${domainLimit}`);
console.log(`  issued:  ${issued}`);
console.log(`  expires: ${expires}`);
console.log(`  id:      ${payload.licenseId}`);
console.log("");
console.log("DIVE_LICENSE token (give this to the customer):");
console.log("");
console.log(token);
console.log("");

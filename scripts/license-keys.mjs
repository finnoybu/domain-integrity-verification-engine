#!/usr/bin/env node
/**
 * Generate the Ed25519 keypair used to sign DIVE license tokens.
 *
 * Run once:
 *   node scripts/license-keys.mjs
 *
 * - Writes the PRIVATE key to license-private-key.pem (gitignored via *.pem).
 *   Keep this file secret and backed up — it signs every license, and a
 *   replacement keypair invalidates every license already issued.
 * - Prints the PUBLIC key. Paste it into LICENSE_PUBLIC_KEY_PEM in
 *   src/lib/license.ts.
 *
 * Refuses to overwrite an existing private key.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const PRIVATE_KEY_PATH = "license-private-key.pem";

if (existsSync(PRIVATE_KEY_PATH)) {
  console.error(`Refusing to overwrite existing ${PRIVATE_KEY_PATH}.`);
  console.error("Delete it deliberately only if you intend to replace the keypair —");
  console.error("every license signed by the old key will stop verifying.");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

writeFileSync(
  PRIVATE_KEY_PATH,
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);

console.log(`Private key written to ${PRIVATE_KEY_PATH} — keep it secret, back it up.`);
console.log("");
console.log("Paste this public key into LICENSE_PUBLIC_KEY_PEM in src/lib/license.ts:");
console.log("");
console.log(publicKey.export({ type: "spki", format: "pem" }).trimEnd());
console.log("");

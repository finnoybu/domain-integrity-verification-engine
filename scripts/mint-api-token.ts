/**
 * API-token management CLI. Until the /account UI lands (a post-v0.3.0
 * follow-up), this is how operators create, list, and revoke the
 * `Authorization: Bearer` tokens that integrations and scripts use against
 * DIVE's API.
 *
 * Usage (via `npm run token -- <args>` or `npx tsx scripts/mint-api-token.ts`):
 *
 *   mint <name> [email]   Mint a new token; prints the plaintext ONCE.
 *                         Defaults to the first admin user if no email given.
 *   list [email]          List a user's tokens (no plaintext — only metadata).
 *                         Defaults to all tokens if no email given.
 *   revoke <id>           Revoke a token by id.
 *
 * The plaintext is shown only at mint time — it is stored hashed and cannot be
 * recovered. Lost a token? Revoke it and mint a new one.
 */

import {
  getUserByEmail,
  listUsers,
  mintApiToken,
  listApiTokensForUser,
  listAllApiTokens,
  revokeApiToken,
} from "../src/lib/auth";
import { closeDb } from "../src/lib/db";

function fail(message: string): never {
  console.error(`error: ${message}`);
  closeDb();
  process.exit(1);
}

function resolveUserId(email: string | undefined, action: string): number {
  if (email) {
    const user = getUserByEmail(email);
    if (!user) fail(`no user with email '${email}'`);
    return user!.id;
  }
  const admins = listUsers().filter((u) => u.isAdmin);
  if (admins.length === 0) {
    fail(
      `no admin user exists to ${action} a token for. Set ADMIN_BOOTSTRAP_EMAIL and start the app once, or pass an explicit email.`,
    );
  }
  return admins[0].id;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "mint": {
      const name = rest[0];
      const email = rest[1];
      if (!name) fail("usage: mint <name> [email]");
      const userId = resolveUserId(email, "mint");
      const token = mintApiToken(userId, name);
      console.log(`Minted API token "${token.name}" (id ${token.id}).`);
      console.log("");
      console.log("  " + token.plaintext);
      console.log("");
      console.log(
        "This is the only time the token is shown. Store it now; set it as the",
      );
      console.log(
        "Authorization: Bearer value for your integration / monitor wrapper.",
      );
      break;
    }

    case "list": {
      const email = rest[0];
      const rows = email
        ? listApiTokensForUser(resolveUserId(email, "list")).map((t) => ({
            ...t,
            userId: getUserByEmail(email)!.id,
          }))
        : listAllApiTokens();
      if (rows.length === 0) {
        console.log("No API tokens.");
        break;
      }
      for (const t of rows) {
        const state = t.revokedAt ? `revoked ${t.revokedAt}` : "active";
        const used = t.lastUsedAt ? `last used ${t.lastUsedAt}` : "never used";
        console.log(
          `#${t.id}  ${t.name}  [${state}]  (created ${t.createdAt}, ${used})`,
        );
      }
      break;
    }

    case "revoke": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) fail("usage: revoke <id>");
      const ok = revokeApiToken(id);
      console.log(
        ok
          ? `Revoked token #${id}.`
          : `Token #${id} not found or already revoked.`,
      );
      break;
    }

    default:
      console.error(
        "usage: mint-api-token <mint|list|revoke> [...]\n" +
          "  mint <name> [email]   mint a token (prints plaintext once)\n" +
          "  list [email]          list tokens (metadata only)\n" +
          "  revoke <id>           revoke a token by id",
      );
      closeDb();
      process.exit(1);
  }

  closeDb();
}

main();

#!/usr/bin/env tsx
/**
 * Generate an operator's TOTP secret for the admin panel's write elevation.
 *
 * Each operator has a secret of their own (#730), set on the admin service as
 * one entry of ADMIN_TOTP_SECRETS: "login=SECRET", entries separated by commas.
 * The login is the operator's tailnet login, exactly as it is listed in
 * ADMIN_OPERATOR_LOGINS.
 *
 * Prints the entry (for the ADMIN_TOTP_SECRETS Railway variable) and the
 * otpauth URI (to enrol an authenticator app) to the terminal and nowhere
 * else. Run it once per operator per environment, with a different secret
 * each time, and never paste the output anywhere but the Railway variable and
 * the authenticator. Nothing is written to disk.
 *
 * An operator who already has the old shared ADMIN_TOTP_SECRET in their
 * authenticator can keep it: set "login=<that secret>" as their entry instead
 * of enrolling a new one, then remove ADMIN_TOTP_SECRET.
 */

import { randomBytes } from "node:crypto";

import { encodeBase32, otpauthUri } from "../src/admin/http/totp.js";

const environment = process.argv[2] ?? "development";
const login = (process.argv[3] ?? "").trim();
if ((environment !== "development" && environment !== "production") || !login || login.includes("=") || login.includes(",")) {
  console.error("usage: npm run admin:totp-enrol -- <development|production> <operator tailnet login>");
  process.exit(2);
}

const secret = encodeBase32(randomBytes(20));
const account = `letter-irl-admin-${environment === "production" ? "prod" : "dev"} (${login})`;

console.log(`ADMIN_TOTP_SECRETS entry for ${login} in ${environment} (add it on the letter-irl-admin service, then clear this terminal):`);
console.log(`${login}=${secret}`);
console.log("");
console.log("otpauth URI for this operator's authenticator app (enter the secret manually or build a QR code locally):");
console.log(otpauthUri("Letter IRL admin", account, secret));

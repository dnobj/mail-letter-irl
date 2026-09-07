#!/usr/bin/env tsx
/**
 * Generate a TOTP secret for the admin panel's write elevation.
 *
 * Prints the base32 secret (for the ADMIN_TOTP_SECRET Railway variable) and
 * the otpauth URI (to enrol an authenticator app) to the terminal and nowhere
 * else. Run it once per environment, with a different secret each time, and
 * never paste the output anywhere but the Railway variable and the
 * authenticator. Nothing is written to disk.
 */

import { randomBytes } from "node:crypto";

import { encodeBase32, otpauthUri } from "../src/admin/http/totp.js";

const environment = process.argv[2] ?? "development";
if (environment !== "development" && environment !== "production") {
  console.error("usage: npm run admin:totp-enrol -- <development|production>");
  process.exit(2);
}

const secret = encodeBase32(randomBytes(20));
const account = `letter-irl-admin-${environment === "production" ? "prod" : "dev"}`;

console.log(`ADMIN_TOTP_SECRET for ${environment} (set it on the letter-irl-admin service, then clear this terminal):`);
console.log(secret);
console.log("");
console.log("otpauth URI for the authenticator app (enter the secret manually or build a QR code locally):");
console.log(otpauthUri("Letter IRL admin", account, secret));

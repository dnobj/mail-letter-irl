import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP on RFC 4226 HOTP: HMAC-SHA1, 30-second steps, six digits,
 * implemented on node:crypto so the privileged surface adds no dependency.
 * The verifier accepts one step of clock skew either way and never accepts
 * a counter at or below the last one it accepted, so a code cannot be
 * replayed inside its window.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(input: string): Buffer {
  const normalized = input.replace(/[\s=-]/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function encodeBase32(bytes: Buffer): string {
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const TOTP_STEP_SECONDS = 30;

export function totpCounter(unixSeconds: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(unixSeconds / stepSeconds);
}

export function totp(secret: Buffer, unixSeconds: number, digits = 6): string {
  return hotp(secret, totpCounter(unixSeconds), digits);
}

export type TotpVerification = { ok: true; counter: number } | { ok: false; reason: "invalid" | "replayed" };

/**
 * Accept the current step and its two neighbours, but only counters above
 * the last accepted one. Comparison is constant-time per candidate.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  options: { nowSeconds: number; lastCounter?: number | null; skewSteps?: number },
): TotpVerification {
  const presented = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(presented)) return { ok: false, reason: "invalid" };
  const skew = options.skewSteps ?? 1;
  const current = totpCounter(options.nowSeconds);
  const presentedBuffer = Buffer.from(presented, "utf8");
  let matchedCounter: number | null = null;
  for (let counter = current - skew; counter <= current + skew; counter += 1) {
    const expected = Buffer.from(hotp(secret, counter), "utf8");
    if (expected.length === presentedBuffer.length && timingSafeEqual(expected, presentedBuffer)) {
      matchedCounter = counter;
    }
  }
  if (matchedCounter === null) return { ok: false, reason: "invalid" };
  if (options.lastCounter !== null && options.lastCounter !== undefined && matchedCounter <= options.lastCounter) {
    return { ok: false, reason: "replayed" };
  }
  return { ok: true, counter: matchedCounter };
}

export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

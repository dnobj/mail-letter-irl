import { describe, expect, it } from "vitest";

import {
  decodeBase32,
  encodeBase32,
  hotp,
  otpauthUri,
  totp,
  totpCounter,
  verifyTotp,
} from "../../../src/admin/http/totp.js";

// RFC 6238 Appendix B, HMAC-SHA1: the ASCII secret "12345678901234567890".
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors (eight digits) and the RFC 4226 HOTP vector", () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(totp(RFC_SECRET, seconds, 8), `T=${seconds}`).toBe(expected);
    }
    // RFC 4226 Appendix D, counter 0 through 3 for the same secret.
    expect(hotp(RFC_SECRET, 0)).toBe("755224");
    expect(hotp(RFC_SECRET, 1)).toBe("287082");
    expect(hotp(RFC_SECRET, 2)).toBe("359152");
    expect(hotp(RFC_SECRET, 3)).toBe("969429");
  });

  it("round-trips base32 and decodes the RFC secret", () => {
    expect(decodeBase32(RFC_SECRET_BASE32).equals(RFC_SECRET)).toBe(true);
    expect(encodeBase32(RFC_SECRET)).toBe(RFC_SECRET_BASE32);
    // "JBSWY3DP" is "Hello", "EHPK3PXP" is "!" then 0xDEADBEEF; spaces and
    // case are ignored, as an operator would type it.
    expect(
      decodeBase32("jbsw y3dp ehpk 3pxp").equals(
        Buffer.concat([Buffer.from("Hello!", "ascii"), Buffer.from([0xde, 0xad, 0xbe, 0xef])]),
      ),
    ).toBe(true);
    expect(() => decodeBase32("not base32!")).toThrow();
  });

  it("accepts one step of skew either way, nothing further", () => {
    const now = 1_700_000_000;
    const counter = totpCounter(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter), { nowSeconds: now })).toEqual({ ok: true, counter });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter - 1), { nowSeconds: now })).toEqual({ ok: true, counter: counter - 1 });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter + 1), { nowSeconds: now })).toEqual({ ok: true, counter: counter + 1 });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter + 2), { nowSeconds: now })).toEqual({ ok: false, reason: "invalid" });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter - 2), { nowSeconds: now })).toEqual({ ok: false, reason: "invalid" });
    expect(verifyTotp(RFC_SECRET, "12345", { nowSeconds: now })).toEqual({ ok: false, reason: "invalid" });
    expect(verifyTotp(RFC_SECRET, "abcdef", { nowSeconds: now })).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a counter at or below the last accepted one", () => {
    const now = 1_700_000_000;
    const counter = totpCounter(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter), { nowSeconds: now, lastCounter: counter })).toEqual({
      ok: false,
      reason: "replayed",
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter - 1), { nowSeconds: now, lastCounter: counter })).toEqual({
      ok: false,
      reason: "replayed",
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter + 1), { nowSeconds: now, lastCounter: counter })).toEqual({
      ok: true,
      counter: counter + 1,
    });
  });

  it("builds an otpauth URI with SHA1, six digits and a 30-second period", () => {
    const uri = otpauthUri("Letter IRL admin", "letter-irl-admin-dev", RFC_SECRET_BASE32);
    expect(uri.startsWith("otpauth://totp/Letter%20IRL%20admin%3Aletter-irl-admin-dev?")).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET_BASE32}`);
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

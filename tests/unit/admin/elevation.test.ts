import { describe, expect, it } from "vitest";

import { attemptElevation, dropElevation, isElevated, requireElevation } from "../../../src/admin/http/elevation.js";
import { AdminSessionStore } from "../../../src/admin/http/session.js";
import { decodeBase32, hotp, totpCounter } from "../../../src/admin/http/totp.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const policy = { ttlMs: 10 * 60_000, maxFailures: 5, failureWindowMs: 15 * 60_000 };

function session() {
  const store = new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 });
  return store.create({ login: "owner@example.com", name: "Owner", node: "laptop", peerAddress: "100.64.0.5" });
}

function codeAt(nowMs: number, offset = 0): string {
  return hotp(decodeBase32(SECRET), totpCounter(Math.floor(nowMs / 1000)) + offset);
}

describe("write elevation", () => {
  it("elevates for the policy's lifetime on a valid code and remembers the counter", () => {
    const current = session();
    const now = 1_700_000_000_000;
    const attempt = attemptElevation(current, SECRET, codeAt(now), policy, now);
    expect(attempt).toEqual({ ok: true, elevatedUntil: now + policy.ttlMs });
    expect(isElevated(current, now + policy.ttlMs - 1)).toBe(true);
    expect(isElevated(current, now + policy.ttlMs)).toBe(false);
    expect(current.lastTotpCounter).toBe(totpCounter(now / 1000));
    expect(() => requireElevation(current, now + 1)).not.toThrow();
    expect(() => requireElevation(current, now + policy.ttlMs + 1)).toThrowError(
      expect.objectContaining({ code: "ADMIN_ELEVATION_REQUIRED" }),
    );
  });

  it("refuses the same code twice inside its window", () => {
    const current = session();
    const now = 1_700_000_000_000;
    expect(attemptElevation(current, SECRET, codeAt(now), policy, now).ok).toBe(true);
    dropElevation(current);
    expect(attemptElevation(current, SECRET, codeAt(now), policy, now + 1_000)).toMatchObject({ ok: false, reason: "replayed" });
    expect(attemptElevation(current, SECRET, codeAt(now, 1), policy, now + 1_000).ok).toBe(true);
  });

  it("locks elevation after five failures inside the window and refuses even a valid code while locked", () => {
    const current = session();
    const now = 1_700_000_000_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = attemptElevation(current, SECRET, "000000", policy, now + attempt);
      expect(result).toMatchObject({ ok: false, reason: "invalid", failuresLeft: 5 - attempt, lockedUntil: null });
    }
    const fifth = attemptElevation(current, SECRET, "000000", policy, now + 5);
    expect(fifth).toMatchObject({ ok: false, reason: "locked", lockedUntil: now + 5 + policy.failureWindowMs });
    expect(attemptElevation(current, SECRET, codeAt(now), policy, now + 6)).toMatchObject({ ok: false, reason: "locked" });
    expect(() => requireElevation(current, now + 6)).toThrowError(expect.objectContaining({ code: "ADMIN_ELEVATION_LOCKED" }));
    // The lock lifts with the window, and old failures no longer count.
    const later = now + 5 + policy.failureWindowMs + 1;
    expect(attemptElevation(current, SECRET, codeAt(later), policy, later).ok).toBe(true);
  });

  it("forgets failures older than the window", () => {
    const current = session();
    const now = 1_700_000_000_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      attemptElevation(current, SECRET, "000000", policy, now + attempt);
    }
    const later = now + policy.failureWindowMs + 10;
    expect(attemptElevation(current, SECRET, "000000", policy, later)).toMatchObject({ ok: false, reason: "invalid", failuresLeft: 4 });
  });
});

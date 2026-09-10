import { describe, expect, it } from "vitest";

import {
  attemptElevation,
  dropElevation,
  isElevated,
  requireElevation,
  ElevationGuard,
} from "../../../src/admin/http/elevation.js";
import { AdminSessionStore } from "../../../src/admin/http/session.js";
import { decodeBase32, hotp, totpCounter } from "../../../src/admin/http/totp.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const policy = { ttlMs: 10 * 60_000, maxFailures: 5, failureWindowMs: 15 * 60_000 };

/**
 * The store is kept, not discarded: a second session for the same login is how
 * an attacker resets anything the guard holds per session, so several cases
 * below need two.
 */
function harness() {
  const store = new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 });
  const binding = { login: "owner@example.com", name: "Owner", node: "laptop", peerAddress: "100.64.0.5" };
  return {
    guard: new ElevationGuard(),
    newSession: () => store.create(binding),
    otherLogin: () =>
      store.create({ ...binding, login: "second@example.com", peerAddress: "100.64.0.6" }),
  };
}

function codeAt(nowMs: number, offset = 0): string {
  return hotp(decodeBase32(SECRET), totpCounter(Math.floor(nowMs / 1000)) + offset);
}

describe("write elevation", () => {
  it("elevates for the policy's lifetime on a valid code and remembers the counter", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    const now = 1_700_000_000_000;
    const attempt = attemptElevation(current, guard, SECRET, codeAt(now), policy, now);
    expect(attempt).toEqual({ ok: true, elevatedUntil: now + policy.ttlMs });
    expect(isElevated(current, now + policy.ttlMs - 1)).toBe(true);
    expect(isElevated(current, now + policy.ttlMs)).toBe(false);
    expect(guard.lastAcceptedCounter(SECRET)).toBe(totpCounter(now / 1000));
    expect(() => requireElevation(current, guard, now + 1)).not.toThrow();
    expect(() => requireElevation(current, guard, now + policy.ttlMs + 1)).toThrowError(
      expect.objectContaining({ code: "ADMIN_ELEVATION_REQUIRED" }),
    );
  });

  it("refuses the same code twice inside its window", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    const now = 1_700_000_000_000;
    expect(attemptElevation(current, guard, SECRET, codeAt(now), policy, now).ok).toBe(true);
    dropElevation(current);
    expect(attemptElevation(current, guard, SECRET, codeAt(now), policy, now + 1_000)).toMatchObject({ ok: false, reason: "replayed" });
    expect(attemptElevation(current, guard, SECRET, codeAt(now, 1), policy, now + 1_000).ok).toBe(true);
  });

  it("refuses a replayed code on a second session, not just the one that used it", () => {
    // The replay guard belongs to the secret, so a code observed on one
    // session cannot be spent again on a fresh one inside its window.
    const { guard, newSession } = harness();
    const now = 1_700_000_000_000;
    expect(attemptElevation(newSession(), guard, SECRET, codeAt(now), policy, now).ok).toBe(true);
    expect(
      attemptElevation(newSession(), guard, SECRET, codeAt(now), policy, now + 1_000),
    ).toMatchObject({ ok: false, reason: "replayed" });
  });

  it("locks elevation after five failures inside the window and refuses even a valid code while locked", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    const now = 1_700_000_000_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = attemptElevation(current, guard, SECRET, "000000", policy, now + attempt);
      expect(result).toMatchObject({ ok: false, reason: "invalid", failuresLeft: 5 - attempt, lockedUntil: null });
    }
    const fifth = attemptElevation(current, guard, SECRET, "000000", policy, now + 5);
    expect(fifth).toMatchObject({ ok: false, reason: "locked", lockedUntil: now + 5 + policy.failureWindowMs });
    expect(attemptElevation(current, guard, SECRET, codeAt(now), policy, now + 6)).toMatchObject({ ok: false, reason: "locked" });
    expect(() => requireElevation(current, guard, now + 6)).toThrowError(expect.objectContaining({ code: "ADMIN_ELEVATION_LOCKED" }));
    // The lock lifts with the window, and old failures no longer count.
    const later = now + 5 + policy.failureWindowMs + 1;
    expect(attemptElevation(current, guard, SECRET, codeAt(later), policy, later).ok).toBe(true);
  });

  it("keeps the lock when every attempt arrives on a brand-new session", () => {
    // A request that presents no cookie is authenticated by the Tailscale
    // headers alone and is given a fresh session. When the failure count lived
    // there, dropping the cookie between attempts reset it and the lock never
    // engaged. It is keyed by login now, so the sixth code is refused however
    // many sessions the attempts are spread across.
    const { guard, newSession } = harness();
    const now = 1_700_000_000_000;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      attemptElevation(newSession(), guard, SECRET, "000000", policy, now + attempt);
    }
    const fresh = newSession();
    expect(attemptElevation(fresh, guard, SECRET, codeAt(now), policy, now + 6)).toMatchObject({
      ok: false,
      reason: "locked",
    });
    expect(() => requireElevation(fresh, guard, now + 6)).toThrowError(
      expect.objectContaining({ code: "ADMIN_ELEVATION_LOCKED" }),
    );
  });

  it("locks the operator who failed, not everyone", () => {
    const { guard, newSession, otherLogin } = harness();
    const now = 1_700_000_000_000;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      attemptElevation(newSession(), guard, SECRET, "000000", policy, now + attempt);
    }
    expect(guard.lockedUntil("owner@example.com", now + 6)).not.toBeNull();
    expect(guard.lockedUntil("second@example.com", now + 6)).toBeNull();
    expect(() => requireElevation(otherLogin(), guard, now + 6)).toThrowError(
      // Refused for wanting elevation, not for the other operator's lock.
      expect.objectContaining({ code: "ADMIN_ELEVATION_REQUIRED" }),
    );
  });

  it("forgets failures older than the window", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    const now = 1_700_000_000_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      attemptElevation(current, guard, SECRET, "000000", policy, now + attempt);
    }
    const later = now + policy.failureWindowMs + 10;
    expect(attemptElevation(current, guard, SECRET, "000000", policy, later)).toMatchObject({ ok: false, reason: "invalid", failuresLeft: 4 });
  });
});

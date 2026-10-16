import { describe, expect, it } from "vitest";

import {
  MAX_LOCK_MS,
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

  it("doubles each lock after the first, up to a day, until a code is accepted (#730)", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    let at = 1_700_000_000_000;
    /** Five wrong codes from `at`: the lock they earn, in ms from the fifth. */
    const lockAfterFive = () => {
      let result = attemptElevation(current, guard, SECRET, "000000", policy, at);
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        expect(result.ok).toBe(false);
        result = attemptElevation(current, guard, SECRET, "000000", policy, at + attempt);
      }
      expect(result).toMatchObject({ ok: false, reason: "locked" });
      const lockedFor = (result as { lockedUntil: number }).lockedUntil - (at + 5);
      at = (result as { lockedUntil: number }).lockedUntil + 1;
      return lockedFor;
    };
    const window = policy.failureWindowMs;
    expect(lockAfterFive()).toBe(window);
    expect(lockAfterFive()).toBe(window * 2);
    expect(lockAfterFive()).toBe(window * 4);
    expect(lockAfterFive()).toBe(window * 8);
    expect(lockAfterFive()).toBe(window * 16);
    expect(lockAfterFive()).toBe(window * 32);
    // 15 minutes x 128 is past a day: a lock is never longer than one.
    expect(lockAfterFive()).toBe(window * 64);
    expect(lockAfterFive()).toBe(MAX_LOCK_MS);
    expect(lockAfterFive()).toBe(MAX_LOCK_MS);
    // A code accepted after the last lock: the next lock is the first again.
    expect(attemptElevation(current, guard, SECRET, codeAt(at), policy, at).ok).toBe(true);
    at += 60_000;
    expect(lockAfterFive()).toBe(window);
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

  it("counts failures since the last accepted code, however far apart they come (#730)", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    const now = 1_700_000_000_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      attemptElevation(current, guard, SECRET, "000000", policy, now + attempt);
    }
    // A day later, the fifth still counts.
    const later = now + 24 * 60 * 60_000;
    expect(attemptElevation(current, guard, SECRET, "000000", policy, later)).toMatchObject({ ok: false, reason: "locked" });
  });

  it("locks a guesser who paces four tries per window, and doubles the locks", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    let at = 1_700_000_000_000;
    let tries = 0;
    const locks: number[] = [];
    // Four tries per window, for two days: each try waits out any lock.
    const end = at + 2 * 24 * 60 * 60_000;
    while (at < end) {
      for (let attempt = 0; attempt < 4 && at < end; attempt += 1) {
        const lock = guard.lockedUntil("owner@example.com", at);
        if (lock !== null) at = lock + 1;
        const result = attemptElevation(current, guard, SECRET, "000000", policy, at);
        tries += 1;
        if (!result.ok && result.reason === "locked" && result.lockedUntil !== null) locks.push(result.lockedUntil - at);
        at += 1;
      }
      at += policy.failureWindowMs;
    }
    // Locked from the fifth try on, each lock twice the last until the cap.
    expect(locks.slice(0, 4)).toEqual([1, 2, 4, 8].map((factor) => policy.failureWindowMs * factor));
    expect(Math.max(...locks)).toBe(MAX_LOCK_MS);
    // Far from the ~384 tries two windows' pacing used to allow in a day.
    expect(tries).toBeLessThan(60);
  });

  it("counts five more after a lock lifts, saying how many are left, then locks for twice as long", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    const now = 1_700_000_000_000;
    let last = attemptElevation(current, guard, SECRET, "000000", policy, now);
    for (let attempt = 1; attempt < 5; attempt += 1) last = attemptElevation(current, guard, SECRET, "000000", policy, now + attempt);
    expect(last).toMatchObject({ ok: false, reason: "locked", lockedUntil: now + 4 + policy.failureWindowMs });
    const lifted = now + 4 + policy.failureWindowMs + 1;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(attemptElevation(current, guard, SECRET, "000000", policy, lifted + attempt)).toMatchObject({
        ok: false,
        reason: "invalid",
        failuresLeft: 4 - attempt,
        lockedUntil: null,
      });
    }
    expect(attemptElevation(current, guard, SECRET, "000000", policy, lifted + 4)).toMatchObject({
      ok: false,
      reason: "locked",
      lockedUntil: lifted + 4 + 2 * policy.failureWindowMs,
    });
  });

  it("starts the count again once a code is accepted", () => {
    const { guard, newSession } = harness();
    const current = newSession();
    const now = 1_700_000_000_000;
    for (let attempt = 1; attempt <= 4; attempt += 1) attemptElevation(current, guard, SECRET, "000000", policy, now + attempt);
    expect(attemptElevation(current, guard, SECRET, codeAt(now), policy, now + 10).ok).toBe(true);
    expect(attemptElevation(current, guard, SECRET, "000000", policy, now + 20)).toMatchObject({
      ok: false,
      reason: "invalid",
      failuresLeft: 4,
    });
  });
});

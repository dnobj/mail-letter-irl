import { createHash } from "node:crypto";

import { AdminFoundationError } from "../errors.js";
import type { AdminSession } from "./session.js";
import { decodeBase32, verifyTotp } from "./totp.js";

/**
 * Step-up for writes. Tailnet membership is continuous, so the application
 * checks a second factor itself: a TOTP code from an authenticator the owner
 * keeps on another device. Success marks the session elevated for a bounded
 * time (10 minutes in production, 60 in development); five failures inside
 * fifteen minutes lock elevation for the operator. Every production command
 * requires a live elevation.
 */

export interface ElevationPolicy {
  ttlMs: number;
  maxFailures: number;
  failureWindowMs: number;
}

export type ElevationAttempt =
  | { ok: true; elevatedUntil: number }
  | { ok: false; reason: "locked" | "invalid" | "replayed"; lockedUntil: number | null; failuresLeft: number };

interface LoginElevationState {
  /** Timestamps of recent failures, pruned to the policy window. */
  failures: number[];
  lockedUntil: number | null;
}

/**
 * The elevation state that must outlive any one session.
 *
 * The failure count, the lock and the last accepted TOTP counter used to sit
 * on the session object, and a session is cheap to replace. A request that
 * presents no cookie is authenticated by the Tailscale headers alone and is
 * given a fresh session with every counter back at zero, so a caller who takes
 * a new session between batches of guesses accumulated no failures and was
 * never locked. (The CSRF token is bound to the session id, so the cheap way
 * to do that is a GET, which mints both, rather than a bare cookie-less POST.)
 * A code accepted by one session likewise stayed acceptable to the next inside
 * its window.
 *
 * Neither piece of state describes a session: the failure history belongs to
 * the operator, and the accepted counter belongs to the environment's TOTP
 * secret. Both live here, for the life of the process, which is the same
 * lifetime as the session store and the same "revoke everything" lever: a
 * restart.
 */
export class ElevationGuard {
  private readonly byLogin = new Map<string, LoginElevationState>();
  private readonly counterBySecret = new Map<string, number>();

  /** Identify a secret without holding it as a map key. */
  private static secretKey(secretBase32: string): string {
    return createHash("sha256").update(secretBase32).digest("hex").slice(0, 32);
  }

  /** The lock standing against this login, or null. Clears an expired one. */
  lockedUntil(login: string, now: number): number | null {
    const state = this.byLogin.get(login);
    if (!state || state.lockedUntil === null) return null;
    if (state.lockedUntil <= now) {
      state.lockedUntil = null;
      return null;
    }
    return state.lockedUntil;
  }

  /**
   * Record a failed attempt, applying the lock once the policy's threshold is
   * reached inside its window.
   */
  recordFailure(
    login: string,
    now: number,
    policy: ElevationPolicy,
  ): { lockedUntil: number | null; failuresLeft: number } {
    const state = this.byLogin.get(login) ?? { failures: [], lockedUntil: null };
    state.failures = state.failures.filter(
      (at) => now - at < policy.failureWindowMs,
    );
    state.failures.push(now);
    if (state.failures.length >= policy.maxFailures) {
      state.lockedUntil = now + policy.failureWindowMs;
      this.byLogin.set(login, state);
      return { lockedUntil: state.lockedUntil, failuresLeft: 0 };
    }
    this.byLogin.set(login, state);
    return {
      lockedUntil: null,
      failuresLeft: Math.max(policy.maxFailures - state.failures.length, 0),
    };
  }

  /** A code was accepted: the operator's failure history starts again. */
  clearFailures(login: string): void {
    this.byLogin.delete(login);
  }

  lastAcceptedCounter(secretBase32: string): number | null {
    return this.counterBySecret.get(ElevationGuard.secretKey(secretBase32)) ?? null;
  }

  rememberCounter(secretBase32: string, counter: number): void {
    this.counterBySecret.set(ElevationGuard.secretKey(secretBase32), counter);
  }
}

export function isElevated(session: AdminSession, now: number): boolean {
  return session.elevatedUntil !== null && session.elevatedUntil > now;
}

export function requireElevation(
  session: AdminSession,
  guard: ElevationGuard,
  now: number,
): void {
  // The lock is checked before the elevation, and it is keyed by login, so a
  // locked operator is refused on every session they hold rather than on the
  // one that tripped it.
  if (guard.lockedUntil(session.login, now) !== null) {
    throw new AdminFoundationError("ADMIN_ELEVATION_LOCKED");
  }
  if (!isElevated(session, now)) {
    throw new AdminFoundationError("ADMIN_ELEVATION_REQUIRED");
  }
}

export function dropElevation(session: AdminSession): void {
  session.elevatedUntil = null;
}

/**
 * Verify a code against the guard's replay state and the operator's failure
 * history. Elevation itself stays on the session, because it is a property of
 * this browser; the failure memory and the accepted counter do not.
 */
export function attemptElevation(
  session: AdminSession,
  guard: ElevationGuard,
  secretBase32: string,
  code: string,
  policy: ElevationPolicy,
  now: number,
): ElevationAttempt {
  const standingLock = guard.lockedUntil(session.login, now);
  if (standingLock !== null) {
    return { ok: false, reason: "locked", lockedUntil: standingLock, failuresLeft: 0 };
  }

  const verification = verifyTotp(decodeBase32(secretBase32), code, {
    nowSeconds: Math.floor(now / 1000),
    lastCounter: guard.lastAcceptedCounter(secretBase32),
  });
  if (verification.ok) {
    guard.rememberCounter(secretBase32, verification.counter);
    guard.clearFailures(session.login);
    session.elevatedUntil = now + policy.ttlMs;
    return { ok: true, elevatedUntil: session.elevatedUntil };
  }

  const outcome = guard.recordFailure(session.login, now, policy);
  if (outcome.lockedUntil !== null) {
    // Any elevation this session held goes with the lock; requireElevation
    // refuses the operator's other sessions on the lock itself.
    session.elevatedUntil = null;
    return { ok: false, reason: "locked", lockedUntil: outcome.lockedUntil, failuresLeft: 0 };
  }
  return { ok: false, reason: verification.reason, lockedUntil: null, failuresLeft: outcome.failuresLeft };
}

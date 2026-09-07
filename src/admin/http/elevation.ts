import { AdminFoundationError } from "../errors.js";
import type { AdminSession } from "./session.js";
import { decodeBase32, verifyTotp } from "./totp.js";

/**
 * Step-up for writes. Tailnet membership is continuous, so the application
 * checks a second factor itself: a TOTP code from an authenticator the owner
 * keeps on another device. Success marks the session elevated for a bounded
 * time (10 minutes in production, 60 in development); five failures inside
 * fifteen minutes lock elevation for the session. Every production command
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

export function isElevated(session: AdminSession, now: number): boolean {
  return session.elevatedUntil !== null && session.elevatedUntil > now;
}

export function requireElevation(session: AdminSession, now: number): void {
  if (session.elevationLockedUntil !== null && session.elevationLockedUntil > now) {
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
 * Verify a code against the session's replay state and failure history.
 * Mutates the session: on success sets the elevation and remembers the
 * counter; on failure records the attempt and applies the lockout.
 */
export function attemptElevation(
  session: AdminSession,
  secretBase32: string,
  code: string,
  policy: ElevationPolicy,
  now: number,
): ElevationAttempt {
  session.elevationFailures = session.elevationFailures.filter(
    (at) => now - at < policy.failureWindowMs,
  );
  if (session.elevationLockedUntil !== null && session.elevationLockedUntil > now) {
    return { ok: false, reason: "locked", lockedUntil: session.elevationLockedUntil, failuresLeft: 0 };
  }
  session.elevationLockedUntil = null;

  const verification = verifyTotp(decodeBase32(secretBase32), code, {
    nowSeconds: Math.floor(now / 1000),
    lastCounter: session.lastTotpCounter,
  });
  if (verification.ok) {
    session.lastTotpCounter = verification.counter;
    session.elevationFailures = [];
    session.elevatedUntil = now + policy.ttlMs;
    return { ok: true, elevatedUntil: session.elevatedUntil };
  }

  session.elevationFailures.push(now);
  const failuresLeft = Math.max(policy.maxFailures - session.elevationFailures.length, 0);
  if (session.elevationFailures.length >= policy.maxFailures) {
    session.elevationLockedUntil = now + policy.failureWindowMs;
    session.elevatedUntil = null;
    return { ok: false, reason: "locked", lockedUntil: session.elevationLockedUntil, failuresLeft: 0 };
  }
  return { ok: false, reason: verification.reason, lockedUntil: null, failuresLeft };
}

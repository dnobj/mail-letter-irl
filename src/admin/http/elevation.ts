import { AdminFoundationError } from "../errors.js";
import type { AdminSession } from "./session.js";
import { decodeBase32, verifyTotp } from "./totp.js";
import { MemoryTotpCounterStore, type TotpCounterStore } from "./totpCounters.js";

/**
 * Step-up for writes. Tailnet membership is continuous, so the application
 * checks a second factor itself: a TOTP code from an authenticator the owner
 * keeps on another device. Success marks the session elevated for a bounded
 * time (10 minutes in production, 60 in development). Every fifth failure
 * since the operator's last accepted code locks elevation for them, however
 * far apart the failures came: fifteen minutes the first time, and each
 * further lock twice the one before, up to a day (#730). Counting within a
 * window instead let a guesser who paced four tries per window go on for
 * ever; now any guesser gets a few dozen tries the first day and five a day
 * after. Every production command requires a live elevation.
 */

/** The longest one lock lasts, however many came before it. */
export const MAX_LOCK_MS = 24 * 60 * 60_000;

export interface ElevationPolicy {
  ttlMs: number;
  maxFailures: number;
  failureWindowMs: number;
}

export type ElevationAttempt =
  | { ok: true; elevatedUntil: number }
  | { ok: false; reason: "locked" | "invalid" | "replayed"; lockedUntil: number | null; failuresLeft: number };

interface LoginElevationState {
  /** Failures since a code was last accepted: every `maxFailures`-th locks. */
  failures: number;
  lockedUntil: number | null;
  /** Locks applied since a code was last accepted: each doubles the next. */
  lockouts: number;
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
 * Neither piece of state describes a session. The failure history belongs to
 * the operator and lives here, for the life of the process, which is the same
 * lifetime as the session store and the same "revoke everything" lever: a
 * restart. The accepted counter belongs to the operator's secret and lives in
 * the database (TotpCounterStore, #730), so a restart does not forget it; this
 * in-memory store is only the default for callers that pass none.
 */
export class ElevationGuard {
  private readonly byLogin = new Map<string, LoginElevationState>();
  /** The accepted counters when no store is passed: tests, and nothing else. */
  readonly counters: TotpCounterStore = new MemoryTotpCounterStore();

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
   * Record a failed attempt, applying a lock at every `maxFailures`-th since
   * the last accepted code. The lock lasts the policy's window, doubled for
   * each lock before it, up to MAX_LOCK_MS.
   */
  recordFailure(
    login: string,
    now: number,
    policy: ElevationPolicy,
  ): { lockedUntil: number | null; failuresLeft: number } {
    const state = this.byLogin.get(login) ?? { failures: 0, lockedUntil: null, lockouts: 0 };
    state.failures += 1;
    if (state.failures % policy.maxFailures === 0) {
      const lockMs = Math.min(policy.failureWindowMs * 2 ** state.lockouts, MAX_LOCK_MS);
      state.lockouts += 1;
      state.lockedUntil = now + lockMs;
      this.byLogin.set(login, state);
      return { lockedUntil: state.lockedUntil, failuresLeft: 0 };
    }
    this.byLogin.set(login, state);
    return {
      lockedUntil: null,
      failuresLeft: policy.maxFailures - (state.failures % policy.maxFailures),
    };
  }

  /** A code was accepted: the operator's failure history, and the lock's doubling, start again. */
  clearFailures(login: string): void {
    this.byLogin.delete(login);
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
 * Verify a code against the stored replay state and the operator's failure
 * history. Elevation itself stays on the session, because it is a property of
 * this browser; the failure memory and the accepted counter do not.
 *
 * `counters` is where the accepted counter is kept and `counterKey` its key:
 * the operator's login while each has a secret of their own, one shared key
 * under the legacy shared secret (#730). A code is accepted only if its
 * counter is above the stored one and the store takes it, in one statement,
 * so two processes cannot both accept the same code.
 */
export async function attemptElevation(
  session: AdminSession,
  guard: ElevationGuard,
  secretBase32: string,
  code: string,
  policy: ElevationPolicy,
  now: number,
  options: { counters?: TotpCounterStore; counterKey?: string } = {},
): Promise<ElevationAttempt> {
  const standingLock = guard.lockedUntil(session.login, now);
  if (standingLock !== null) {
    return { ok: false, reason: "locked", lockedUntil: standingLock, failuresLeft: 0 };
  }

  const counters = options.counters ?? guard.counters;
  const counterKey = options.counterKey ?? session.login;
  const checked = verifyTotp(decodeBase32(secretBase32), code, {
    nowSeconds: Math.floor(now / 1000),
    lastCounter: await counters.lastCounter(counterKey),
  });
  // A counter another process accepted between the read and the claim is a
  // replay too.
  const verification =
    checked.ok && !(await counters.claim(counterKey, checked.counter))
      ? ({ ok: false, reason: "replayed" } as const)
      : checked;
  if (verification.ok) {
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

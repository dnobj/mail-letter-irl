import { createHash, randomBytes } from "node:crypto";

/**
 * In-memory operator sessions.
 *
 * Tailnet membership is continuous and device-level, so the application keeps
 * its own session to obtain idle and absolute expiry, a binding to the login,
 * the peer address and the node that whois reported, and the elevation state
 * that gates writes. One instance is guaranteed (a Railway service with a
 * volume cannot have replicas), so memory is the right store: a restart drops
 * every session, which is also the "revoke everything" lever.
 */

export const SESSION_COOKIE_NAME = "__Host-lirl_admin";

export interface SessionBinding {
  login: string;
  name: string;
  node: string;
  peerAddress: string;
}

export interface AdminSession extends SessionBinding {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  /**
   * Elevation is a property of this browser, so it stays here. The failure
   * history, the lock and the last accepted TOTP counter do not: a session is
   * cheap to replace, so anything the second factor relies on lives in
   * ElevationGuard instead (see elevation.ts).
   */
  elevatedUntil: number | null;
  /** One message shown on the next page render, then cleared. */
  flash: { tone: "ok" | "warn" | "bad"; text: string } | null;
}

export interface AdminSessionStoreOptions {
  idleTtlMs: number;
  absoluteTtlMs: number;
  now?: () => number;
  maxSessions?: number;
}

export type SessionResolution =
  | { kind: "ok"; session: AdminSession }
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "binding_mismatch" };

function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminSession>();
  private readonly idleTtlMs: number;
  private readonly absoluteTtlMs: number;
  private readonly now: () => number;
  private readonly maxSessions: number;

  constructor(options: AdminSessionStoreOptions) {
    this.idleTtlMs = options.idleTtlMs;
    this.absoluteTtlMs = options.absoluteTtlMs;
    this.now = options.now ?? (() => Date.now());
    this.maxSessions = options.maxSessions ?? 100;
  }

  get size(): number {
    return this.sessions.size;
  }

  create(binding: SessionBinding): AdminSession {
    this.prune();
    if (this.sessions.size >= this.maxSessions) {
      // Drop the oldest rather than refuse: an operator locked out by their
      // own stale tabs would be worse than a stale tab losing its session.
      const oldest = [...this.sessions.values()].sort(
        (a, b) => a.lastSeenAt - b.lastSeenAt,
      )[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
    const now = this.now();
    const session: AdminSession = {
      id: newSessionId(),
      createdAt: now,
      lastSeenAt: now,
      elevatedUntil: null,
      flash: null,
      ...binding,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private isExpired(session: AdminSession, now: number): boolean {
    return (
      now - session.lastSeenAt > this.idleTtlMs ||
      now - session.createdAt > this.absoluteTtlMs
    );
  }

  /**
   * Look a session up and re-check its binding. A mismatch destroys the
   * session: a cookie presented from another login or another peer address is
   * treated as theft, not as a new device.
   *
   * The node is stored on the session but not compared here, and this comment
   * used to claim it was. It cannot be: the node name comes from a whois of
   * the peer address, which runs only when a session is created, so comparing
   * it per request would mean a whois per request. Little is lost, because the
   * node is derived from the peer address that is compared - a cookie arriving
   * from another device brings another address with it.
   */
  resolve(
    id: string | undefined,
    binding: Pick<SessionBinding, "login" | "peerAddress">,
  ): SessionResolution {
    if (!id) return { kind: "missing" };
    const session = this.sessions.get(id);
    if (!session) return { kind: "missing" };
    const now = this.now();
    if (this.isExpired(session, now)) {
      this.sessions.delete(id);
      return { kind: "expired" };
    }
    if (
      session.login !== binding.login ||
      session.peerAddress !== binding.peerAddress
    ) {
      this.sessions.delete(id);
      return { kind: "binding_mismatch" };
    }
    session.lastSeenAt = now;
    return { kind: "ok", session };
  }

  /** New id, same state: required after any privilege change. */
  rotate(session: AdminSession): AdminSession {
    this.sessions.delete(session.id);
    const rotated: AdminSession = { ...session, id: newSessionId() };
    this.sessions.set(rotated.id, rotated);
    return rotated;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  destroyAll(): void {
    this.sessions.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session, now)) this.sessions.delete(id);
    }
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/**
 * The one cookie the panel sets. `__Host-` requires Secure, Path=/ and no
 * Domain, which browsers enforce; over the Serve HTTPS origin (and on
 * localhost, which browsers treat as secure) that is exactly what we want.
 */
export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE_NAME}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

import { describe, expect, it } from "vitest";

import {
  AdminSessionStore,
  SESSION_COOKIE_NAME,
  clearedSessionCookie,
  hashSessionId,
  parseCookies,
  sessionCookie,
} from "../../../src/admin/http/session.js";

const binding = {
  login: "owner@example.com",
  name: "Owner",
  node: "owner-laptop.tail1234.ts.net",
  peerAddress: "100.64.0.5",
};

function store(now: { value: number }, overrides: Partial<{ idle: number; absolute: number; max: number }> = {}) {
  return new AdminSessionStore({
    idleTtlMs: overrides.idle ?? 15 * 60_000,
    absoluteTtlMs: overrides.absolute ?? 8 * 3_600_000,
    maxSessions: overrides.max,
    now: () => now.value,
  });
}

describe("admin session store", () => {
  it("creates sessions with 256-bit ids and resolves them by binding", () => {
    const now = { value: 1_000_000 };
    const sessions = store(now);
    const session = sessions.create(binding);
    expect(Buffer.from(session.id, "base64url")).toHaveLength(32);
    expect(sessions.resolve(session.id, binding)).toMatchObject({ kind: "ok" });
    expect(sessions.resolve(undefined, binding)).toEqual({ kind: "missing" });
    expect(sessions.resolve("nope", binding)).toEqual({ kind: "missing" });
  });

  it("expires on idle and on absolute age", () => {
    const now = { value: 0 };
    const sessions = store(now, { idle: 1_000, absolute: 5_000 });
    const idle = sessions.create(binding);
    now.value = 1_001;
    expect(sessions.resolve(idle.id, binding)).toEqual({ kind: "expired" });
    // Gone for good, not merely reported.
    expect(sessions.resolve(idle.id, binding)).toEqual({ kind: "missing" });

    now.value = 10_000;
    const absolute = sessions.create(binding);
    for (let tick = 1; tick <= 6; tick += 1) {
      now.value = 10_000 + tick * 900;
      const resolution = sessions.resolve(absolute.id, binding);
      if (now.value - 10_000 > 5_000) {
        expect(resolution).toEqual({ kind: "expired" });
      } else {
        expect(resolution.kind).toBe("ok");
      }
    }
  });

  it("destroys a session presented from another login or peer", () => {
    const now = { value: 0 };
    const sessions = store(now);
    const session = sessions.create(binding);
    expect(
      sessions.resolve(session.id, { login: "other@example.com", peerAddress: binding.peerAddress }),
    ).toEqual({ kind: "binding_mismatch" });
    expect(sessions.resolve(session.id, binding)).toEqual({ kind: "missing" });

    const second = sessions.create(binding);
    expect(
      sessions.resolve(second.id, { login: binding.login, peerAddress: "100.64.0.99" }),
    ).toEqual({ kind: "binding_mismatch" });
  });

  it("rotates ids without losing state and caps the number of sessions", () => {
    const now = { value: 0 };
    const sessions = store(now, { max: 2 });
    const first = sessions.create(binding);
    first.elevatedUntil = 42;
    const rotated = sessions.rotate(first);
    expect(rotated.id).not.toBe(first.id);
    expect(rotated.elevatedUntil).toBe(42);
    expect(sessions.resolve(first.id, binding)).toEqual({ kind: "missing" });
    expect(sessions.resolve(rotated.id, binding).kind).toBe("ok");

    now.value = 10;
    sessions.create(binding);
    now.value = 20;
    sessions.create(binding);
    expect(sessions.size).toBe(2);
    expect(sessions.resolve(rotated.id, binding)).toEqual({ kind: "missing" });
  });

  it("parses and serialises the one cookie with the __Host- attributes", () => {
    const cookies = parseCookies(`a=1; ${SESSION_COOKIE_NAME}=abc.def; a=2; broken`);
    expect(cookies.get(SESSION_COOKIE_NAME)).toBe("abc.def");
    expect(cookies.get("a")).toBe("1");
    expect(parseCookies(undefined).size).toBe(0);
    expect(sessionCookie("xyz")).toBe(
      "__Host-lirl_admin=xyz; Path=/; Secure; HttpOnly; SameSite=Strict",
    );
    expect(clearedSessionCookie()).toContain("Max-Age=0");
    expect(hashSessionId("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

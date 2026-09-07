import { describe, expect, it, vi } from "vitest";

import { AdminSessionStore, SESSION_COOKIE_NAME } from "../../../src/admin/http/session.js";
import { authenticateAdminRequest, type AuthRequestView } from "../../../src/admin/http/tailscaleAuth.js";
import type { WhoisClient } from "../../../src/admin/tailscale/cli.js";

const HOST = "letter-irl-admin-dev.tail1234.ts.net";

function view(
  headers: Record<string, string>,
  options: { remoteAddress?: string; cookie?: string } = {},
): AuthRequestView {
  return {
    remoteAddress: "remoteAddress" in options ? options.remoteAddress : "127.0.0.1",
    header: (name) => headers[name.toLowerCase()],
    cookie: (name) => (name === SESSION_COOKIE_NAME ? options.cookie : undefined),
  };
}

const goodHeaders = {
  "tailscale-user-login": "owner@example.com",
  "tailscale-user-name": "Owner",
  "x-forwarded-host": HOST,
  "x-forwarded-for": "100.64.0.5",
  "x-forwarded-proto": "https",
};

function harness(whoisResult: { login: string; nodeName: string } | null = { login: "owner@example.com", nodeName: "laptop.tail1234.ts.net" }) {
  const whois: WhoisClient = {
    whois: vi.fn(async () => (whoisResult ? { ...whoisResult, displayName: null } : null)),
  };
  const sessions = new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 });
  const options = {
    allowedLogins: new Set(["owner@example.com"]),
    expectedHost: HOST,
    whois,
    sessions,
  };
  return { whois, sessions, options };
}

describe("tailnet request authentication", () => {
  it("creates a session for an allowlisted login whose whois agrees, then reuses it by cookie", async () => {
    const { options, whois } = harness();
    const first = await authenticateAdminRequest(view(goodHeaders), options);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.created).toBe(true);
    expect(first.actor).toEqual({ id: "owner@example.com", name: "Owner", node: "laptop.tail1234.ts.net" });
    expect(whois.whois).toHaveBeenCalledWith("100.64.0.5");

    const second = await authenticateAdminRequest(view(goodHeaders, { cookie: first.session.id }), options);
    expect(second).toMatchObject({ ok: true, created: false });
    expect(whois.whois).toHaveBeenCalledTimes(1);
  });

  it("refuses anything that is not the loopback socket", async () => {
    const { options } = harness();
    for (const remoteAddress of ["10.0.0.4", "fd12::1", undefined]) {
      expect(await authenticateAdminRequest(view(goodHeaders, { remoteAddress }), options)).toMatchObject({
        ok: false,
        code: "ADMIN_UNAUTHENTICATED",
        reason: "not_loopback",
      });
    }
    expect((await authenticateAdminRequest(view(goodHeaders, { remoteAddress: "::ffff:127.0.0.1" }), options)).ok).toBe(true);
  });

  it("refuses a missing or malformed login header, a Funnel request, and a wrong forwarded host", async () => {
    const { options } = harness();
    const { "tailscale-user-login": _login, ...noLogin } = goodHeaders;
    expect(await authenticateAdminRequest(view(noLogin), options)).toMatchObject({ reason: "login_header_missing" });
    expect(
      await authenticateAdminRequest(view({ ...goodHeaders, "tailscale-user-login": "<script>" }), options),
    ).toMatchObject({ reason: "login_header_missing" });
    expect(
      await authenticateAdminRequest(view({ ...goodHeaders, "tailscale-funnel-request": "?1" }), options),
    ).toMatchObject({ reason: "funnel", code: "ADMIN_UNAUTHENTICATED" });
    expect(
      await authenticateAdminRequest(view({ ...goodHeaders, "x-forwarded-host": "evil.example" }), options),
    ).toMatchObject({ reason: "host_mismatch" });
    expect(
      (await authenticateAdminRequest(view({ ...goodHeaders, "x-forwarded-host": `${HOST.toUpperCase()}:443` }), options)).ok,
    ).toBe(true);
    const { "x-forwarded-for": _peer, ...noPeer } = goodHeaders;
    expect(await authenticateAdminRequest(view(noPeer), options)).toMatchObject({ reason: "peer_address_missing" });
  });

  it("refuses a login that is not allowlisted with 403 and records the presented login", async () => {
    const { options } = harness({ login: "stranger@example.com", nodeName: "x.ts.net" });
    expect(
      await authenticateAdminRequest(view({ ...goodHeaders, "tailscale-user-login": "stranger@example.com" }), options),
    ).toEqual({
      ok: false,
      code: "ADMIN_FORBIDDEN",
      reason: "not_allowlisted",
      presentedLogin: "stranger@example.com",
    });
  });

  it("refuses when whois disagrees with the header, fails, or names a tagged peer", async () => {
    const disagree = harness({ login: "other@example.com", nodeName: "x.ts.net" });
    expect(await authenticateAdminRequest(view(goodHeaders), disagree.options)).toMatchObject({
      ok: false,
      reason: "whois_disagrees",
    });
    const tagged = harness(null);
    expect(await authenticateAdminRequest(view(goodHeaders), tagged.options)).toMatchObject({
      ok: false,
      reason: "whois_disagrees",
    });
    const failing = harness();
    (failing.whois.whois as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("socket"));
    expect(await authenticateAdminRequest(view(goodHeaders), failing.options)).toMatchObject({
      ok: false,
      reason: "whois_disagrees",
    });
  });

  it("re-evaluates a cookie from another peer as a new session after destroying the old one", async () => {
    const { options, sessions, whois } = harness();
    const first = await authenticateAdminRequest(view(goodHeaders), options);
    if (!first.ok) throw new Error("unreachable");
    const moved = await authenticateAdminRequest(
      view({ ...goodHeaders, "x-forwarded-for": "100.64.0.9" }, { cookie: first.session.id }),
      options,
    );
    expect(moved).toMatchObject({ ok: true, created: true, replaced: "binding_mismatch" });
    expect(sessions.resolve(first.session.id, { login: "owner@example.com", peerAddress: "100.64.0.5" })).toEqual({
      kind: "missing",
    });
    expect(whois.whois).toHaveBeenCalledTimes(2);
  });

  it("never trusts a session cookie in place of the identity checks", async () => {
    const { options } = harness();
    const first = await authenticateAdminRequest(view(goodHeaders), options);
    if (!first.ok) throw new Error("unreachable");
    const { "tailscale-user-login": _login, ...noLogin } = goodHeaders;
    expect(await authenticateAdminRequest(view(noLogin, { cookie: first.session.id }), options)).toMatchObject({
      ok: false,
      reason: "login_header_missing",
    });
  });

  it("uses the configured login in local-dev mode and ignores inbound identity headers", async () => {
    const { options, whois } = harness();
    const result = await authenticateAdminRequest(
      view({ "tailscale-user-login": "attacker@example.com" }),
      { ...options, expectedHost: null, localDev: { login: "owner@example.com", name: "local developer" } },
    );
    expect(result).toMatchObject({ ok: true, actor: { id: "owner@example.com", node: "local-dev" } });
    expect(whois.whois).not.toHaveBeenCalled();
  });
});

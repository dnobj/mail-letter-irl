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

describe("a request another site sent may use a live session, never start one (#730)", () => {
  const crossSite = (options: ReturnType<typeof harness>["options"]) => ({ ...options, allowNewSession: false });

  it("refuses quietly with no cookie or an unknown one, before whois", async () => {
    const { options, whois, sessions } = harness();
    for (const cookie of [undefined, "forged-or-gone"]) {
      expect(await authenticateAdminRequest(view(goodHeaders, { cookie }), crossSite(options))).toMatchObject({
        ok: false,
        code: "ADMIN_UNAUTHENTICATED",
        reason: "cross_site_new_session",
        quiet: true,
      });
    }
    expect(whois.whois).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  it("refuses quietly with an expired session's cookie", async () => {
    const clock = { value: 0 };
    const { options, whois } = harness();
    const sessions = new AdminSessionStore({ idleTtlMs: 10, absoluteTtlMs: 600_000, now: () => clock.value });
    const old = sessions.create({ login: "owner@example.com", name: "Owner", node: "laptop", peerAddress: "100.64.0.5" });
    clock.value = 1000;
    expect(await authenticateAdminRequest(view(goodHeaders, { cookie: old.id }), { ...crossSite(options), sessions })).toMatchObject({ quiet: true });
    expect(whois.whois).not.toHaveBeenCalled();
  });

  it("uses a live session", async () => {
    const { options } = harness();
    const first = await authenticateAdminRequest(view(goodHeaders), options);
    if (!first.ok) throw new Error("unreachable");
    expect(await authenticateAdminRequest(view(goodHeaders, { cookie: first.session.id }), crossSite(options))).toMatchObject({ ok: true, created: false });
  });

  it("records a cookie presented from another peer as before, not quietly", async () => {
    const { options, sessions, whois } = harness();
    const theirs = sessions.create({ login: "owner@example.com", name: "Owner", node: "laptop", peerAddress: "100.64.0.9" });
    const outcome = await authenticateAdminRequest(view(goodHeaders, { cookie: theirs.id }), crossSite(options));
    expect(outcome).not.toMatchObject({ quiet: true });
    expect(outcome).toMatchObject({ ok: true, created: true, replaced: "binding_mismatch" });
    expect(whois.whois).toHaveBeenCalled();
  });

  it("still runs the proxy and login checks first, and audits them", async () => {
    const { options } = harness();
    expect(await authenticateAdminRequest(view({ ...goodHeaders, "x-forwarded-host": "elsewhere.ts.net" }), crossSite(options))).toMatchObject({
      reason: "host_mismatch",
    });
    expect(await authenticateAdminRequest(view({ ...goodHeaders, "x-forwarded-host": "elsewhere.ts.net" }), crossSite(options))).not.toMatchObject({ quiet: true });
    expect(await authenticateAdminRequest(view({ ...goodHeaders, "tailscale-user-login": "stranger@example.com" }), crossSite(options))).toMatchObject({
      code: "ADMIN_FORBIDDEN",
    });
  });
});

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

  it("tells a whois that disagrees or names a tagged peer apart from one that fails", async () => {
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
    // A daemon that cannot answer is a different operational problem from a
    // peer that does not match, and the audit row should not conflate them.
    const failing = harness();
    (failing.whois.whois as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("socket"));
    expect(await authenticateAdminRequest(view(goodHeaders), failing.options)).toMatchObject({
      ok: false,
      reason: "whois_failed",
    });
  });

  it("refuses a request that does not carry the proxy's forwarded-proto header", async () => {
    // Serve terminates TLS and sets this. Userspace networking forwards an
    // inbound tunnel connection to the same port on localhost, so a peer the
    // policy lets reach the app port arrives on the loopback listener able to
    // choose its own headers; requiring the whole set the proxy sends raises
    // what such a caller has to reproduce.
    const { options } = harness();
    const { "x-forwarded-proto": _proto, ...withoutProto } = goodHeaders;
    expect(await authenticateAdminRequest(view(withoutProto), options)).toMatchObject({
      ok: false,
      code: "ADMIN_UNAUTHENTICATED",
      reason: "forwarded_proto_missing",
    });
    expect(
      await authenticateAdminRequest(view({ ...goodHeaders, "x-forwarded-proto": "http" }), options),
    ).toMatchObject({ ok: false, reason: "forwarded_proto_missing" });
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

  const LOCAL_DEV = { login: "owner@example.com", name: "local developer", hosts: ["localhost:8790", "127.0.0.1:8790"] };

  it("uses the configured login in local-dev mode and ignores inbound identity headers", async () => {
    const { options, whois } = harness();
    const result = await authenticateAdminRequest(
      view({ "tailscale-user-login": "attacker@example.com", host: "localhost:8790" }),
      { ...options, expectedHost: null, localDev: LOCAL_DEV },
    );
    expect(result).toMatchObject({ ok: true, actor: { id: "owner@example.com", node: "local-dev" } });
    expect(whois.whois).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1:8790", "LOCALHOST:8790"])("answers to the workstation's own name in local-dev mode (%s)", async (host) => {
    const { options } = harness();
    const result = await authenticateAdminRequest(view({ host }), { ...options, expectedHost: null, localDev: LOCAL_DEV });
    expect(result).toMatchObject({ ok: true });
  });

  it.each([["a rebinding page's name", "evil.test:8790"], ["another port", "localhost:9999"], ["no Host", undefined]])(
    "refuses %s in local-dev mode, so a DNS-rebinding page reads nothing (#730)",
    async (_label, host) => {
      const { options } = harness();
      const result = await authenticateAdminRequest(view(host === undefined ? {} : { host }), {
        ...options,
        expectedHost: null,
        localDev: LOCAL_DEV,
      });
      expect(result).toMatchObject({ ok: false, code: "ADMIN_UNAUTHENTICATED", reason: "host_mismatch" });
    },
  );
});

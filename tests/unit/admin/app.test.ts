import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AdminAuditWriter } from "../../../src/admin/auditService.js";
import type { AdminPools } from "../../../src/admin/db.js";
import { clientScriptPath, createAdminRequestListener, type RouteHandler } from "../../../src/admin/http/app.js";
import { AdminRouter } from "../../../src/admin/http/router.js";
import { NAV_ITEMS, registerReadRoutes } from "../../../src/admin/http/routes.js";
import { createCsrfToken } from "../../../src/admin/http/security.js";
import { ElevationGuard } from "../../../src/admin/http/elevation.js";
import { AdminSessionStore, SESSION_COOKIE_NAME } from "../../../src/admin/http/session.js";
import { parseAdminRuntimeConfig } from "../../../src/admin/runtimeConfig.js";
import { validDevelopmentEnv } from "./runtimeConfig.test.js";
import { DenialAuditBudget } from "../../../src/admin/http/denialAuditBudget.js";
import { AdminFoundationError } from "../../../src/admin/errors.js";

/**
 * The request pipeline end to end over a real socket: identity checks,
 * session cookie, browser-boundary checks, CSRF, read-only refusal, the
 * error page, the audit rows each of those produces, and the headers on
 * every response. The database is a scripted pg-shaped stub.
 */

const HOST = "letter-irl-admin-dev.tail1234.ts.net";
const USER_ROW = {
  user_id: "auth0|user1",
  email: "customer@example.com",
  credits: 2,
  credits_purchased: 4,
  credits_used: 2,
  tier: "standard",
  tier_override: null,
  tier_calculated_at: new Date(),
  created_at: new Date(),
  updated_at: new Date(),
  sends_blocked_at: null,
  sends_blocked_reason: null,
  return_address_validated_at: null,
  image_generations_used: 0,
};

function scriptedPool(audits: Array<Record<string, unknown>>) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes("INSERT INTO admin_audit_events")) {
      audits.push({ actor: values[0], action: values[6], targetId: values[8], outcome: values[13], errorCode: values[14], input: values[10] });
      return { rows: [{ id: "audit-1", occurredAt: new Date() }] };
    }
    if (/FROM users WHERE user_id = \$1/.test(text) && values[0] === USER_ROW.user_id) {
      return { rows: [USER_ROW] };
    }
    return { rows: [] };
  });
  const client = { query, release: () => {} };
  return {
    query,
    connect: async () => client,
    end: async () => {},
    on: () => {},
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      let data = "";
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: data }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

const identity = {
  "tailscale-user-login": "owner@example.com",
  "tailscale-user-name": "Owner",
  "x-forwarded-host": HOST,
  "x-forwarded-for": "100.64.0.5",
  "x-forwarded-proto": "https",
};

describe("admin request pipeline", () => {
  const audits: Array<Record<string, unknown>> = [];
  const config = parseAdminRuntimeConfig(validDevelopmentEnv);
  const reader = scriptedPool(audits);
  const pools = { reader, operator: null } as unknown as AdminPools;
  const sessions = new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 });
  const clientScript = { body: "(() => {})();", path: "" };
  clientScript.path = clientScriptPath(clientScript.body);
  const router = registerReadRoutes(new AdminRouter<RouteHandler>(), clientScript);
  router.add("POST", "/writes/echo", async (context) => context.render("Echo", { value: "<p>echo</p>" } as never), {
    name: "writes.echo",
  });
  // A stand-in for the real elevation route: the limiter is keyed on the route
  // name, so this exercises the wiring without the command machinery.
  router.add("POST", "/elevate", async (context) => context.render("Elevate", { value: "<p>elevate</p>" } as never), {
    name: "elevate",
    write: true,
  });
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const listener = createAdminRequestListener({
      config,
      pools,
      sessions,
      elevation: new ElevationGuard(),
      whois: { whois: async () => ({ login: "owner@example.com", displayName: "Owner", nodeName: "laptop.tail1234.ts.net" }) },
      audit: new AdminAuditWriter(),
      router,
      nodeName: HOST,
      banner: {
        environment: "development",
        mode: "read-only",
        marker: "development",
        databaseRole: "letter_irl_admin_reader_development",
        stripeKeyMode: "test",
        stripeKeyRestricted: true,
        letterProvider: "dummy",
        buildCommit: "abc",
        tag: "tag:dev-admin",
      },
      nav: NAV_ITEMS,
      clientScript,
    });
    server = http.createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers 401 with a constant body and no page when the identity headers are absent", async () => {
    const reply = await send(port, "GET", "/", {});
    expect(reply.status).toBe(401);
    expect(reply.body).toBe("unauthorized");
    expect(reply.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(audits.at(-1)).toMatchObject({ action: "admin.request_denied", outcome: "denied", errorCode: "ADMIN_UNAUTHENTICATED" });
  });

  it("answers 403 for a login off the allowlist and records the login it saw", async () => {
    const reply = await send(port, "GET", "/", { ...identity, "tailscale-user-login": "stranger@example.com" });
    expect(reply.status).toBe(403);
    expect(reply.body).toBe("forbidden");
    expect(audits.at(-1)).toMatchObject({ actor: "stranger@example.com", errorCode: "ADMIN_FORBIDDEN" });
  });

  it("renders the overview for an allowlisted operator, starts a session and sets the cookie once", async () => {
    const first = await send(port, "GET", "/", identity);
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toContain("text/html");
    expect(first.headers["content-security-policy"]).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
    const cookie = String(first.headers["set-cookie"]);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict");
    expect(first.body).toContain("Operations overview");
    expect(first.body).toContain("operator: <code>owner@example.com</code>");
    expect(audits.some((audit) => audit.action === "admin.session_start")).toBe(true);

    const sessionId = cookie.split(";")[0].split("=")[1];
    const second = await send(port, "GET", "/lookup", { ...identity, cookie: `${SESSION_COOKIE_NAME}=${sessionId}` });
    expect(second.status).toBe(200);
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect(second.body).toContain("Lookup");
    expect(sessions.size).toBeGreaterThan(0);
  });

  it("serves the content-addressed client script and nothing else under /assets", async () => {
    const script = await send(port, "GET", clientScript.path, identity);
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(script.body).toBe(clientScript.body);
    const other = await send(port, "GET", "/assets/client-other.js", identity);
    expect(other.status).toBe(404);
  });

  it("renders a 404 page and a 405 constant body", async () => {
    const missing = await send(port, "GET", "/nope", identity);
    expect(missing.status).toBe(404);
    expect(missing.body).toContain("ADMIN_NOT_FOUND");
    const wrongMethod = await send(port, "POST", "/lookup", identity);
    expect(wrongMethod.status).toBe(405);
  });

  it("refuses a POST without the browser-boundary headers, then without the CSRF token, and audits both", async () => {
    const first = await send(port, "GET", "/", identity);
    const sessionId = String(first.headers["set-cookie"]).split(";")[0].split("=")[1];
    const withSession = { ...identity, cookie: `${SESSION_COOKIE_NAME}=${sessionId}` };

    const crossSite = await send(port, "POST", "/accounts/auth0%7Cuser1/reveal", {
      ...withSession,
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "cross-site",
      origin: `https://${HOST}`,
    }, "reason=support+ticket+123");
    expect(crossSite.status).toBe(403);
    expect(audits.at(-1)).toMatchObject({ action: "admin.request_denied", errorCode: "ADMIN_CSRF_REJECTED" });

    const badToken = await send(port, "POST", "/accounts/auth0%7Cuser1/reveal", {
      ...withSession,
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      origin: `https://${HOST}`,
    }, "reason=support+ticket+123&_csrf=" + "0".repeat(64));
    expect(badToken.status).toBe(403);
    expect(audits.at(-1)).toMatchObject({ errorCode: "ADMIN_CSRF_REJECTED" });
  });

  it("performs the audited email reveal with a valid token and refuses a thin reason", async () => {
    const first = await send(port, "GET", "/", identity);
    const sessionId = String(first.headers["set-cookie"]).split(";")[0].split("=")[1];
    const token = createCsrfToken(config.sessionSecret, sessionId);
    const headers = {
      ...identity,
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      origin: `https://${HOST}`,
    };
    const revealed = await send(port, "POST", "/accounts/auth0%7Cuser1/reveal", headers, `reason=support+ticket+123&_csrf=${token}`);
    expect(revealed.status).toBe(200);
    expect(revealed.body).toContain("customer@example.com");
    expect(audits.at(-1)).toMatchObject({ action: "pii.reveal", targetId: "auth0|user1", outcome: "succeeded" });

    const thin = await send(port, "POST", "/accounts/auth0%7Cuser1/reveal", headers, `reason=x&_csrf=${token}`);
    expect(thin.status).toBe(400);
    expect(thin.body).toContain("ADMIN_INVALID_REQUEST");
    expect(audits.some((audit) => audit.action === "pii.reveal" && audit.outcome === "denied")).toBe(true);

    const masked = await send(port, "GET", "/accounts/auth0%7Cuser1", identity);
    expect(masked.body).toContain("c***@example.com");
    expect(masked.body).not.toContain("customer@example.com");
  });

  it("refuses write routes in read-only mode before the handler runs", async () => {
    const first = await send(port, "GET", "/", identity);
    const sessionId = String(first.headers["set-cookie"]).split(";")[0].split("=")[1];
    const token = createCsrfToken(config.sessionSecret, sessionId);
    const reply = await send(port, "POST", "/writes/echo", {
      ...identity,
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      origin: `https://${HOST}`,
    }, `_csrf=${token}`);
    expect(reply.status).toBe(403);
    expect(reply.body).toContain("ADMIN_READ_ONLY_MODE");
    expect(reply.body).not.toContain("echo");
    expect(audits.at(-1)).toMatchObject({ errorCode: "ADMIN_READ_ONLY_MODE", outcome: "denied" });
  });

  it("rate limits the elevation route per login, whether or not the session cookie is presented", async () => {
    // The lock that bounds code guessing is keyed by login; so is this, and
    // for the same reason. A caller that drops its cookie gets a new session
    // on every request, so a limiter keyed on the session would never bite.
    const first = await send(port, "GET", "/", identity);
    const sessionId = String(first.headers["set-cookie"]).split(";")[0].split("=")[1];
    const token = createCsrfToken(config.sessionSecret, sessionId);
    const headers = {
      ...identity,
      cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
      origin: `https://${HOST}`,
    };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const reply = await send(port, "POST", "/elevate", headers, `_csrf=${token}`);
      statuses.push(reply.status);
    }
    // Ten get through to the read-only refusal; the rest are limited. The
    // limiter deliberately sits ahead of that refusal so the same budget
    // applies in full mode, where the handler would verify a code.
    expect(statuses.slice(0, 10).every((status) => status === 403)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(audits.at(-1)).toMatchObject({
      errorCode: "ADMIN_RATE_LIMITED",
      outcome: "denied",
      targetId: "elevate",
    });

    // Starting a fresh session does not restore the budget. A POST with no
    // cookie at all is refused earlier, by the CSRF check, because the token
    // is bound to a session id the caller cannot predict; the way to get a
    // clean session is a GET, which mints both. That is the shape of the
    // attack this limiter and the per-login lock exist to bound, so it is the
    // shape the test uses.
    const second = await send(port, "GET", "/", identity);
    const freshId = String(second.headers["set-cookie"]).split(";")[0].split("=")[1];
    expect(freshId).not.toBe(sessionId);
    const onFreshSession = await send(port, "POST", "/elevate", {
      ...headers,
      cookie: `${SESSION_COOKIE_NAME}=${freshId}`,
    }, `_csrf=${createCsrfToken(config.sessionSecret, freshId)}`);
    expect(onFreshSession.status).toBe(429);
  });
});

describe("admin audit completeness", () => {
  // Audit A-15: denials beyond the per-minute budget are aggregated rather
  // than dropped, a rate-limited authenticated request is a denial like any
  // other, and every failure of a write route is audited whatever its status.
  // Full mode, so write routes reach their handlers.
  const audits: Array<Record<string, unknown>> = [];
  const config = parseAdminRuntimeConfig({
    ...validDevelopmentEnv,
    ADMIN_MODE: "full",
    ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    // Full mode requires the primary connection to be the operator role.
    DATABASE_URL: String(validDevelopmentEnv.DATABASE_URL).replace(
      "letter_irl_admin_reader_development",
      "letter_irl_admin_operator_development",
    ),
  });
  const reader = scriptedPool(audits);
  const pools = { reader, operator: null } as unknown as AdminPools;
  const sessions = new AdminSessionStore({ idleTtlMs: 600_000, absoluteTtlMs: 6_000_000 });
  const clientScript = { body: "(() => {})();", path: "" };
  clientScript.path = clientScriptPath(clientScript.body);
  const router = registerReadRoutes(new AdminRouter<RouteHandler>(), clientScript);
  router.add(
    "POST",
    "/writes/invalid",
    async () => {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    },
    { name: "writes.invalid", write: true },
  );
  let clock = Date.parse("2026-09-08T12:00:00Z");
  const now = () => clock;
  const denialBudget = new DenialAuditBudget({ limit: 3, windowMs: 60_000, now });
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const listener = createAdminRequestListener({
      config,
      pools,
      sessions,
      elevation: new ElevationGuard(),
      whois: { whois: async () => ({ login: "owner@example.com", displayName: "Owner", nodeName: "laptop.tail1234.ts.net" }) },
      audit: new AdminAuditWriter(),
      router,
      nodeName: HOST,
      banner: {
        environment: "development",
        mode: "full",
        marker: "development",
        databaseRole: "letter_irl_admin_reader_development",
        stripeKeyMode: "test",
        stripeKeyRestricted: true,
        letterProvider: "dummy",
        buildCommit: "abc",
        tag: "tag:dev-admin",
      },
      nav: NAV_ITEMS,
      clientScript,
      now,
      denialBudget,
    });
    server = http.createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function summaryOf(row: Record<string, unknown>): Record<string, unknown> {
    return typeof row.input === "string" ? JSON.parse(row.input) : (row.input as Record<string, unknown>);
  }

  it("counts denials beyond the per-minute budget into one aggregate row instead of dropping them", async () => {
    for (let i = 0; i < 5; i += 1) {
      const reply = await send(port, "GET", "/", { ...identity, "tailscale-user-login": `stranger${i}@example.com` });
      expect(reply.status).toBe(403);
    }
    expect(audits.filter((row) => row.action === "admin.request_denied")).toHaveLength(3);
    expect(audits.some((row) => row.action === "admin.request_denied_burst")).toBe(false);

    clock += 60_001;
    const later = await send(port, "GET", "/", { ...identity, "tailscale-user-login": "stranger9@example.com" });
    expect(later.status).toBe(403);
    const burst = audits.find((row) => row.action === "admin.request_denied_burst");
    expect(burst).toMatchObject({ actor: "aggregate@admin-panel", outcome: "denied", errorCode: "ADMIN_DENIAL_BURST" });
    expect(summaryOf(burst!)).toMatchObject({
      limit: 3,
      written: 3,
      suppressed: 2,
      distinctActors: 2,
      byCode: { ADMIN_FORBIDDEN: 2 },
      windowStartedAt: "2026-09-08T12:00:00.000Z",
    });
    // The new window writes individually again.
    expect(audits.filter((row) => row.action === "admin.request_denied")).toHaveLength(4);
  });

  it("audits a rate-limited authenticated request", async () => {
    clock += 60_001;
    let last: Reply | undefined;
    for (let i = 0; i < 241; i += 1) last = await send(port, "GET", "/", identity);
    expect(last?.status).toBe(429);
    expect(last?.body).toBe("too many requests");
    expect(audits.at(-1)).toMatchObject({
      action: "admin.request_denied",
      actor: "owner@example.com",
      errorCode: "ADMIN_RATE_LIMITED",
      outcome: "denied",
    });
  });

  it("audits a write-route failure whatever its status", async () => {
    clock += 60_001;
    const first = await send(port, "GET", "/", identity);
    const sessionId = String(first.headers["set-cookie"]).split(";")[0].split("=")[1];
    const token = createCsrfToken(config.sessionSecret, sessionId);
    const reply = await send(
      port,
      "POST",
      "/writes/invalid",
      {
        ...identity,
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        origin: `https://${HOST}`,
      },
      `_csrf=${token}`,
    );
    expect(reply.status).toBe(400);
    expect(audits.at(-1)).toMatchObject({
      action: "admin.request_failed",
      targetId: "writes.invalid",
      outcome: "failed",
      errorCode: "ADMIN_INVALID_REQUEST",
    });
  });
});

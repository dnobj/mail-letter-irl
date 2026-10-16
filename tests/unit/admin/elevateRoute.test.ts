import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminAuditWriter } from "../../../src/admin/auditService.js";
import { ADMIN_COMMANDS } from "../../../src/admin/commands/index.js";
import type { AdminPools } from "../../../src/admin/db.js";
import { clientScriptPath, createAdminRequestListener, type RouteHandler } from "../../../src/admin/http/app.js";
import { registerCommandRoutes } from "../../../src/admin/http/commandRoutes.js";
import { ElevationGuard } from "../../../src/admin/http/elevation.js";
import { AdminRouter } from "../../../src/admin/http/router.js";
import { NAV_ITEMS, registerReadRoutes } from "../../../src/admin/http/routes.js";
import { createCsrfToken } from "../../../src/admin/http/security.js";
import { AdminSessionStore, SESSION_COOKIE_NAME } from "../../../src/admin/http/session.js";
import { decodeBase32, hotp, totpCounter } from "../../../src/admin/http/totp.js";
import { parseAdminRuntimeConfig } from "../../../src/admin/runtimeConfig.js";
import { validDevelopmentEnv } from "./runtimeConfig.test.js";

/**
 * POST /elevate through the real request pipeline in full mode (#730): each
 * operator elevates with their own secret, and the accepted counter is
 * claimed in the database under their login, so a code cannot be used twice.
 */

const HOST = "letter-irl-admin-dev.tail1234.ts.net";
const OPERATOR = "postgres://letter_irl_admin_operator_development:pw@db.example.test/letter_irl_dev";
const OWNER_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

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

// Each operator's laptop, as the Tailscale daemon names it.
const PEERS: Record<string, string> = { "owner@example.com": "100.64.0.5", "second@github": "100.64.0.6" };

function identity(login: string) {
  return {
    "tailscale-user-login": login,
    "tailscale-user-name": "Operator",
    "x-forwarded-host": HOST,
    "x-forwarded-for": PEERS[login],
    "x-forwarded-proto": "https",
  };
}

function currentCode(): string {
  return hotp(decodeBase32(OWNER_SECRET), totpCounter(Math.floor(Date.now() / 1000)));
}

describe("POST /elevate in full mode", () => {
  const config = parseAdminRuntimeConfig({
    ...validDevelopmentEnv,
    ADMIN_MODE: "full",
    DATABASE_URL: OPERATOR,
    ADMIN_TOTP_SECRETS: `owner@example.com=${OWNER_SECRET}`,
  });
  const audits: Array<{ action: unknown; outcome: unknown }> = [];
  const readerQuery = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes("INSERT INTO admin_audit_events")) {
      audits.push({ action: values[6], outcome: values[13] });
      return { rows: [{ id: "audit-1", occurredAt: new Date() }] };
    }
    return { rows: [] };
  });
  // Whether the next claim of a counter wins, as the database would decide.
  let claimWins = true;
  const operatorQuery = vi.fn(async (text: string) => {
    if (text.includes("FROM admin_totp_counters")) return { rows: [], rowCount: 0 };
    if (text.includes("INSERT INTO admin_totp_counters")) {
      return claimWins ? { rows: [{ counter_key: "x" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const readerClient = { query: readerQuery, release: () => {} };
  const reader = { query: readerQuery, connect: async () => readerClient, end: async () => {}, on: () => {} };
  const operator = { query: operatorQuery, connect: async () => ({ query: operatorQuery, release: () => {} }), end: async () => {}, on: () => {} };
  const pools = { reader, operator } as unknown as AdminPools;
  const clientScript = { body: "(() => {})();", path: "" };
  clientScript.path = clientScriptPath(clientScript.body);
  const router = new AdminRouter<RouteHandler>();
  registerReadRoutes(router, clientScript, registerCommandRoutes(router, ADMIN_COMMANDS));
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const listener = createAdminRequestListener({
      config,
      pools,
      sessions: new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 }),
      elevation: new ElevationGuard(),
      whois: {
        whois: async (peer: string) => ({
          login: Object.keys(PEERS).find((login) => PEERS[login] === peer) ?? "",
          displayName: "Operator",
          nodeName: "laptop.tail1234.ts.net",
        }),
      },
      audit: new AdminAuditWriter(),
      router,
      nodeName: HOST,
      banner: {
        environment: "development",
        mode: "full",
        marker: "development",
        databaseRole: "letter_irl_admin_operator_development",
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

  beforeEach(() => {
    claimWins = true;
    operatorQuery.mockClear();
  });

  async function postElevate(login: string, code: string): Promise<Reply> {
    const first = await send(port, "GET", "/", identity(login));
    const sessionId = String(first.headers["set-cookie"]).split(";")[0].split("=")[1];
    const token = createCsrfToken(config.sessionSecret, sessionId);
    return send(
      port,
      "POST",
      "/elevate",
      {
        ...identity(login),
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        origin: `https://${HOST}`,
      },
      `code=${code}&return=%2F&_csrf=${token}`,
    );
  }

  function claims() {
    return operatorQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO admin_totp_counters"));
  }

  it("elevates with the operator's own code and claims its counter under their login", async () => {
    const reply = await postElevate("owner@example.com", currentCode());
    expect(reply.status).toBe(303);
    expect(claims()).toHaveLength(1);
    const [, values] = claims()[0] as unknown as [string, unknown[]];
    expect(values[0]).toBe("owner@example.com");
    expect(audits.at(-1)).toMatchObject({ action: "admin.elevate", outcome: "succeeded" });
  });

  it("refuses a code whose counter the database says was already claimed", async () => {
    claimWins = false;
    const reply = await postElevate("owner@example.com", currentCode());
    expect(reply.status).toBe(403);
    expect(reply.body).toContain("That code was already used");
    expect(claims()).toHaveLength(1);
  });

  it("refuses an operator with no secret of their own, without checking any code", async () => {
    const reply = await postElevate("second@github", currentCode());
    expect(reply.status).toBe(403);
    expect(reply.body).toContain("No TOTP secret is set for second@github");
    expect(operatorQuery).not.toHaveBeenCalled();
  });
});

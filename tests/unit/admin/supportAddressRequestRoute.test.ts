import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AdminAuditWriter } from "../../../src/admin/auditService.js";
import { ADMIN_COMMANDS } from "../../../src/admin/commands/index.js";
import type { AdminPools } from "../../../src/admin/db.js";
import { clientScriptPath, createAdminRequestListener, type RouteHandler } from "../../../src/admin/http/app.js";
import { registerCommandRoutes } from "../../../src/admin/http/commandRoutes.js";
import { ElevationGuard } from "../../../src/admin/http/elevation.js";
import { registerOpsRoutes } from "../../../src/admin/http/opsRoutes.js";
import { AdminRouter } from "../../../src/admin/http/router.js";
import { NAV_ITEMS, registerReadRoutes } from "../../../src/admin/http/routes.js";
import { createCsrfToken } from "../../../src/admin/http/security.js";
import { AdminSessionStore, SESSION_COOKIE_NAME } from "../../../src/admin/http/session.js";
import { parseAdminRuntimeConfig } from "../../../src/admin/runtimeConfig.js";
import { validDevelopmentEnv } from "./runtimeConfig.test.js";

/**
 * POST /support/address-request (#701) through the real request pipeline: the
 * pasted link is reduced to its fingerprint and the operator is sent to the
 * delete's preview by it, so the link's token never travels in a URL; it needs
 * the CSRF token like every write, and is refused in read-only mode.
 */

const HOST = "letter-irl-admin-dev.tail1234.ts.net";
const OPERATOR = "postgres://letter_irl_admin_operator_development:pw@db.example.test/letter_irl_dev";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";
const HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const LINK = `https://www.example.com/address#${TOKEN}`;

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
  "tailscale-user-name": "Operator",
  "x-forwarded-host": HOST,
  "x-forwarded-for": "100.64.0.5",
  "x-forwarded-proto": "https",
};

function panel(mode: "full" | "read-only") {
  const config = parseAdminRuntimeConfig({
    ...validDevelopmentEnv,
    ADMIN_MODE: mode,
    ...(mode === "full"
      ? { DATABASE_URL: OPERATOR, ADMIN_OPERATOR_LOGINS: "owner@example.com", ADMIN_TOTP_SECRETS: "owner@example.com=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }
      : {}),
  });
  const audits: Array<{ action: unknown; input: unknown }> = [];
  const readerQuery = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes("INSERT INTO admin_audit_events")) {
      audits.push({ action: values[6], input: values[10] });
      return { rows: [{ id: "audit-1", occurredAt: new Date() }] };
    }
    return { rows: [] };
  });
  const client = { query: readerQuery, release: () => {} };
  const pool = { query: readerQuery, connect: async () => client, end: async () => {}, on: () => {} };
  const pools = { reader: pool, operator: mode === "full" ? pool : null } as unknown as AdminPools;
  const clientScript = { body: "(() => {})();", path: "" };
  clientScript.path = clientScriptPath(clientScript.body);
  const router = new AdminRouter<RouteHandler>();
  registerReadRoutes(router, clientScript, registerCommandRoutes(router, ADMIN_COMMANDS));
  registerOpsRoutes(router, { retentionReport: async () => ({}) as never, providers: () => [] });
  const listener = createAdminRequestListener({
    config,
    pools,
    sessions: new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 }),
    elevation: new ElevationGuard(),
    whois: { whois: async () => ({ login: "owner@example.com", displayName: "Operator", nodeName: "laptop.tail1234.ts.net" }) },
    audit: new AdminAuditWriter(),
    router,
    nodeName: HOST,
    banner: {
      environment: "development",
      mode,
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
  return { config, audits, server: http.createServer(listener) };
}

describe.each(["full", "read-only"] as const)("POST /support/address-request in %s mode (#701)", (mode) => {
  const { config, audits, server } = panel(mode);
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(body: (csrf: string) => string): Promise<Reply> {
    const first = await send(port, "GET", "/", identity);
    const sessionId = String(first.headers["set-cookie"]).split(";")[0].split("=")[1];
    return send(
      port,
      "POST",
      "/support/address-request",
      {
        ...identity,
        cookie: `${SESSION_COOKIE_NAME}=${sessionId}`,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        origin: `https://${HOST}`,
      },
      body(createCsrfToken(config.sessionSecret, sessionId)),
    );
  }

  if (mode === "full") {
    it("sends the operator to the delete's preview by the link's fingerprint, never with the token", async () => {
      const reply = await post((csrf) => `request=${encodeURIComponent(LINK)}&_csrf=${csrf}`);
      expect(reply.status).toBe(303);
      expect(reply.headers.location).toBe(`/commands/address_request.delete/preview?target=${encodeURIComponent(`link:${HASH}`)}`);
      expect(String(reply.headers.location)).not.toContain(TOKEN);
      expect(JSON.stringify(audits)).not.toContain(TOKEN);
    });

    it("sends anything that names no request back to the Support page, without echoing it", async () => {
      const reply = await post((csrf) => `request=${encodeURIComponent("Jane Doe, 1 Main St")}&_csrf=${csrf}`);
      expect(reply.status).toBe(303);
      expect(reply.headers.location).toBe("/support");
      expect(JSON.stringify(audits)).not.toContain("Jane Doe");
    });
  } else {
    it("is refused in read-only mode, like every write", async () => {
      const reply = await post((csrf) => `request=${encodeURIComponent(LINK)}&_csrf=${csrf}`);
      expect(reply.status).toBe(403);
      expect(String(reply.headers.location ?? "")).not.toContain("address_request.delete");
    });
  }

  it("is refused without the CSRF token", async () => {
    const reply = await post(() => `request=${encodeURIComponent(LINK)}&_csrf=${"0".repeat(64)}`);
    expect(reply.status).toBe(403);
  });
});

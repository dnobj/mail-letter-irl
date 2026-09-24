import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AdminAuditWriter } from "../../../src/admin/auditService.js";
import { ADMIN_COMMANDS } from "../../../src/admin/commands/index.js";
import type { AdminPools } from "../../../src/admin/db.js";
import { registerAccountRoutes } from "../../../src/admin/http/accountRoutes.js";
import { clientScriptPath, createAdminRequestListener, type RouteHandler } from "../../../src/admin/http/app.js";
import { registerCommandRoutes } from "../../../src/admin/http/commandRoutes.js";
import { ElevationGuard } from "../../../src/admin/http/elevation.js";
import { AdminRouter } from "../../../src/admin/http/router.js";
import { NAV_ITEMS, registerReadRoutes } from "../../../src/admin/http/routes.js";
import { AdminSessionStore } from "../../../src/admin/http/session.js";
import { parseAdminRuntimeConfig } from "../../../src/admin/runtimeConfig.js";
import { validDevelopmentEnv } from "./runtimeConfig.test.js";

/**
 * The erasure follow-up (#453) through the real request pipeline, with the
 * routes wired as src/admin/server.ts wires them: the alert's page gets its
 * type through to the resolve form, and the account page finds the alert.
 */

const HOST = "letter-irl-admin-dev.tail1234.ts.net";
const ERASED_USER = "auth0|erased-user";
const FOLLOWUP_ID = "a1b2c3d4-0000-4000-8000-000000000001";
const OTHER_ID = "a1b2c3d4-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-24T18:00:00Z");

const USER_ROW = {
  user_id: ERASED_USER,
  email: "erased-5f0c1e2a-0000-4000-8000-000000000000@erased.invalid",
  credits: 6,
  credits_purchased: 8,
  credits_used: 2,
  tier: "standard",
  tier_override: null,
  tier_calculated_at: NOW,
  created_at: NOW,
  updated_at: NOW,
  sends_blocked_at: NOW,
  sends_blocked_reason: "account_erased",
  return_address_validated_at: null,
  image_generations_used: 0,
};

function alertRow(id: string, type: string, details: Record<string, unknown>, orderId: string | null = null) {
  return {
    alert_id: id,
    alert_type: type,
    severity: "warning",
    status: "open",
    order_id: orderId,
    source_event_id: null,
    details,
    created_at: NOW,
    updated_at: NOW,
    acknowledged_at: null,
    resolved_at: null,
    resolution_code: null,
  };
}

const ALERTS: Record<string, ReturnType<typeof alertRow>> = {
  [FOLLOWUP_ID]: alertRow(FOLLOWUP_ID, "account_erasure_followup", { userId: ERASED_USER }),
  [OTHER_ID]: alertRow(OTHER_ID, "pack_refund_failed", { refundId: "r-1" }, "ord-1"),
};

const identity = {
  "tailscale-user-login": "owner@example.com",
  "tailscale-user-name": "Owner",
  "x-forwarded-host": HOST,
  "x-forwarded-for": "100.64.0.5",
  "x-forwarded-proto": "https",
};

function send(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "GET", path, headers: identity }, (response) => {
      let data = "";
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: data }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("the erasure follow-up in the panel", () => {
  const config = parseAdminRuntimeConfig(validDevelopmentEnv);
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes("INSERT INTO admin_audit_events")) return { rows: [{ id: "audit-1", occurredAt: new Date() }] };
    if (text.includes("FROM commerce_operational_alerts WHERE alert_id = $1::uuid")) {
      const row = ALERTS[String(values[0])];
      return { rows: row ? [row] : [] };
    }
    if (text.includes("details->>'userId' = $2") && values[0] === "account_erasure_followup" && values[1] === ERASED_USER) {
      return { rows: [{ alert_id: FOLLOWUP_ID, status: "open", resolved_at: null, resolution_code: null }] };
    }
    if (text.includes("AS erased FROM users") && values[0] === ERASED_USER) return { rows: [{ erased: true }] };
    if (/FROM users WHERE user_id = \$1/.test(text) && values[0] === ERASED_USER) return { rows: [USER_ROW] };
    return { rows: [] };
  });
  const client = { query, release: () => {} };
  const reader = { query, connect: async () => client, end: async () => {}, on: () => {} };
  const pools = { reader, operator: null } as unknown as AdminPools;
  const clientScript = { body: "(() => {})();", path: "" };
  clientScript.path = clientScriptPath(clientScript.body);
  const router = new AdminRouter<RouteHandler>();
  const extensions = registerCommandRoutes(router, ADMIN_COMMANDS);
  const accountExtensions = registerAccountRoutes(router);
  registerReadRoutes(router, clientScript, { ...extensions, accountActions: accountExtensions.accountActions });
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const listener = createAdminRequestListener({
      config,
      pools,
      sessions: new AdminSessionStore({ idleTtlMs: 60_000, absoluteTtlMs: 600_000 }),
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

  it("lists the steps on the follow-up alert's page and fills its resolve form with the code", async () => {
    const reply = await send(port, `/alerts/${FOLLOWUP_ID}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("What is left to do");
    expect(reply.body).toContain(`href="/accounts/${encodeURIComponent(ERASED_USER)}"`);
    expect(reply.body).toMatch(/name="resolutionCode"[^>]*value="auth0_user_deleted"/);
  });

  it("leaves another alert's page and resolve form as they were", async () => {
    const reply = await send(port, `/alerts/${OTHER_ID}`);
    expect(reply.status).toBe(200);
    expect(reply.body).not.toContain("What is left to do");
    expect(reply.body).toMatch(/name="resolutionCode"[^>]*value=""/);
  });

  it("says on the erased account's page what is still to do, and links the alert", async () => {
    const reply = await send(port, `/accounts/${encodeURIComponent(ERASED_USER)}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("Still to do by hand");
    expect(reply.body).toContain(`href="/alerts/${FOLLOWUP_ID}"`);
  });
});

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
import { renderPromoForm } from "../../../src/admin/pages/promos.js";
import { parseAdminRuntimeConfig } from "../../../src/admin/runtimeConfig.js";
import { validDevelopmentEnv } from "./runtimeConfig.test.js";

/**
 * The two admin defects GIFT-01 step 9 found on development (2026-09-23),
 * driven through the real request pipeline with the routes wired as
 * src/admin/server.ts wires them:
 *
 * - the Create promo campaign form carries no `target` (the campaign does not
 *   exist yet), and the preview route refused every request without one, so
 *   no campaign could ever be created from the panel;
 * - an account that claimed a seed campaign granting only a gift letter has a
 *   promo_redemptions row with a NULL ledger_id (migration 033), and its
 *   account page threw on it (500).
 */

const HOST = "letter-irl-admin-dev.tail1234.ts.net";
const USER_ROW = {
  user_id: "auth0|user1",
  email: "customer@example.com",
  credits: 0,
  credits_purchased: 0,
  credits_used: 0,
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

const identity = {
  "tailscale-user-login": "owner@example.com",
  "tailscale-user-name": "Owner",
  "x-forwarded-host": HOST,
  "x-forwarded-for": "100.64.0.5",
  "x-forwarded-proto": "https",
};

interface Reply {
  status: number;
  body: string;
}

function send(port: number, path: string): Promise<Reply> {
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

describe("seed campaign admin routes", () => {
  const config = parseAdminRuntimeConfig(validDevelopmentEnv);
  const queries: string[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    queries.push(text);
    if (text.includes("INSERT INTO admin_audit_events")) return { rows: [{ id: "audit-1", occurredAt: new Date() }] };
    if (/FROM users WHERE user_id = \$1/.test(text) && values[0] === USER_ROW.user_id) return { rows: [USER_ROW] };
    if (text.includes("FROM promo_redemptions r JOIN promo_campaigns c")) {
      // A seed campaign with credits 0 grants only a gift letter: no lot.
      return { rows: [{ code: "SEED-TEST", name: "Seed test", redeemed_at: new Date(), ledger_id: null }] };
    }
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

  /** The query string the rendered create form submits, with no target added. */
  function createFormQuery(code: string): string {
    const names = [...renderPromoForm().value.matchAll(/\bname="([^"]+)"/g)].map((match) => match[1]);
    // The premise: the form has no target, because the campaign does not exist yet.
    expect(names).not.toContain("target");
    expect(names).toContain("code");
    const values: Record<string, string> = {
      code,
      name: "Seed test",
      description: "",
      creditsAmount: "0",
      expirationDays: "90",
      maxTotalRedemptions: "2",
      giftGenerationsRemaining: "1",
      maxPerUser: "1",
      endsAt: "",
      requiresNewUser: "on",
    };
    const params = new URLSearchParams();
    for (const name of names) {
      expect(values, `the test has no value for the form field ${name}`).toHaveProperty(name);
      params.set(name, values[name]);
    }
    return params.toString();
  }

  it("previews a campaign from the create form as rendered, which carries no target", async () => {
    const reply = await send(port, `/commands/promo.create/preview?${createFormQuery("SEED-TEST")}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("CONFIRM SEED-TEST");
    // The confirmation form that follows carries the target explicitly.
    expect(reply.body).toMatch(/name="target" value="SEED-TEST"/);
    expect(reply.body).toContain("seed code: grants a gift letter with budget 1");
  });

  it("takes the target from the code as typed, normalised the way the code is", async () => {
    const reply = await send(port, `/commands/promo.create/preview?${createFormQuery(" seed-test ")}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("CONFIRM SEED-TEST");
  });

  it("still refuses a target that disagrees with the code", async () => {
    const reply = await send(port, `/commands/promo.create/preview?target=OTHER&${createFormQuery("SEED-TEST")}`);
    expect(reply.status).toBe(400);
    expect(reply.body).toContain("ADMIN_INVALID_REQUEST");
  });

  it("refuses an ordinary campaign that grants no letters, and still takes one that does (#420)", async () => {
    const ordinary = (credits: string) => {
      const params = new URLSearchParams(createFormQuery("ZERO-TEST"));
      params.set("giftGenerationsRemaining", "");
      params.set("creditsAmount", credits);
      return params.toString();
    };
    const none = await send(port, `/commands/promo.create/preview?${ordinary("0")}`);
    expect(none.status).toBe(400);
    expect(none.body).toContain("ADMIN_INVALID_REQUEST");
    const some = await send(port, `/commands/promo.create/preview?${ordinary("2")}`);
    expect(some.status).toBe(200);
    expect(some.body).toContain("none (ordinary promo)");
  });

  it("still refuses a missing target for a command that does not name its own", async () => {
    const reply = await send(port, "/commands/promo.transition/preview?status=active");
    expect(reply.status).toBe(400);
    expect(reply.body).toContain("ADMIN_INVALID_REQUEST");
  });

  it("renders the account of someone who claimed a gift-only seed campaign", async () => {
    queries.length = 0;
    const reply = await send(port, "/accounts/auth0%7Cuser1");
    expect(reply.status).toBe(200);
    // The redemption row was actually read and drawn, not skipped.
    expect(queries.some((text) => text.includes("FROM promo_redemptions r JOIN promo_campaigns c"))).toBe(true);
    expect(reply.body).toContain("<code>SEED-TEST</code>");
    expect(reply.body).toContain("gift only");
  });
});

import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  denyLegacyPublicAdminRoute,
  isLegacyPublicAdminPath,
} from "../../../src/mcp/legacyAdminRoutes.js";

function createResponse() {
  const headers = new Map<string, string>();
  const end = vi.fn();
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) =>
      headers.set(name.toLowerCase(), value),
    end,
  } as unknown as ServerResponse;
  return { response, headers, end };
}

describe("legacy public admin route denial", () => {
  it.each([
    "/admin",
    "/admin/",
    "/admin/users",
    "/admin.html",
    "/admin-panel.html",
    "/api/admin",
    "/api/admin/",
    "/api/admin/users",
    // The legacy dispatcher matches startsWith('/api/admin'), so every prefix
    // extension must be denied here or it reaches the admin rate-limit tier and
    // the admin request boundary instead.
    "/api/adminfoo",
    "/api/admin-panel",
    "/api/adminfoo/bar",
  ])("returns a no-store 404 for %s before any legacy dispatch", (pathname) => {
    const { response, headers, end } = createResponse();

    expect(denyLegacyPublicAdminRoute(pathname, response)).toBe(true);
    expect(response.statusCode).toBe(404);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.has("access-control-allow-origin")).toBe(false);
    expect(end).toHaveBeenCalledWith("Not found");
  });

  // Controls proving the guard was not over-widened. The legacy HTML panel is
  // dispatched by exact match on /admin, /admin.html, and /admin-panel.html, so
  // sibling prefixes on the HTML side must still fall through to normal routing.
  it.each([
    "/",
    "/healthz",
    "/api/credits",
    "/adminfoo",
    "/admin-panel",
    "/administrator",
    "/admin.html.bak",
  ])("does not intercept public service path %s", (pathname) => {
    const { response, end } = createResponse();

    expect(isLegacyPublicAdminPath(pathname)).toBe(false);
    expect(denyLegacyPublicAdminRoute(pathname, response)).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(end).not.toHaveBeenCalled();
  });

  it("keeps the denial guard ahead of health, CORS, and legacy handlers", async () => {
    const source = await readFile("src/mcp/httpServer.ts", "utf8");
    const guardIndex = source.indexOf(
      "denyLegacyPublicAdminRoute(url.pathname, res)",
    );

    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(
      source.indexOf('url.pathname === "/healthz"'),
    );

    // Every legacy admin surface must exist and must sit behind the guard. A
    // missing marker is a failure, not a skip: silently tolerating -1 is how
    // this assertion previously passed against a CORS preflight block that had
    // already been deleted upstream.
    const markersBehindGuard = [
      "url.pathname.startsWith('/api/admin')",
      "handleAdminApiRequest(req, res",
      'url.pathname === "/admin-panel.html"',
    ];
    for (const marker of markersBehindGuard) {
      const markerIndex = source.indexOf(marker);
      expect(markerIndex, `missing dispatcher marker: ${marker}`).toBeGreaterThan(
        -1,
      );
      expect(markerIndex).toBeGreaterThan(guardIndex);
    }
  });

  it("keeps the guard predicate exactly as wide as the legacy dispatcher", async () => {
    const httpServerSource = await readFile("src/mcp/httpServer.ts", "utf8");
    const handlerSource = await readFile("src/api/adminApiHandler.ts", "utf8");
    const guardSource = await readFile("src/mcp/legacyAdminRoutes.ts", "utf8");

    // Both legacy dispatch sites match on the bare prefix. A substring check
    // alone only catches a NARROWED dispatcher, so it is paired with the
    // literal sweep below, which catches a widened one.
    expect(httpServerSource).toContain("url.pathname.startsWith('/api/admin')");
    expect(handlerSource).toContain("pathname.startsWith('/api/admin')");
    expect(guardSource).toContain('pathname.startsWith("/api/admin")');

    // Every admin-ish path literal either dispatch site mentions must be inside
    // the guard's surface. Appending a clause such as
    // `|| url.pathname.startsWith('/api/adm')` introduces a literal that is a
    // strict prefix of /api/admin, which the guard does not deny, and this
    // fails rather than passing on the still-present original substring.
    const adminishLiterals = (source: string): string[] => [
      ...new Set(
        [...source.matchAll(/['"`](\/api\/adm[^'"`]*)['"`]/g)].map(
          (match) => match[1],
        ),
      ),
    ];

    const dispatcherLiterals = [
      ...new Set([
        ...adminishLiterals(httpServerSource),
        ...adminishLiterals(handlerSource),
      ]),
    ].sort();

    // Non-vacuity: the sweep must actually find the dispatch literals.
    expect(dispatcherLiterals).toContain("/api/admin");
    expect(dispatcherLiterals.length).toBeGreaterThan(1);

    for (const literal of dispatcherLiterals) {
      expect(
        literal.startsWith("/api/admin"),
        `dispatch literal ${literal} is wider than the guard surface /api/admin`,
      ).toBe(true);
      expect(
        isLegacyPublicAdminPath(literal),
        `dispatch literal ${literal} is not denied by the guard`,
      ).toBe(true);
    }

    // Representative paths the bare-prefix dispatcher accepts, including the
    // ones that previously bypassed the narrower guard.
    for (const pathname of [
      "/api/admin",
      "/api/admin/",
      "/api/admin/users",
      "/api/adminfoo",
      "/api/admin-panel",
      "/api/administrator",
      "/api/admin/image-generation/ambiguous",
    ]) {
      expect(isLegacyPublicAdminPath(pathname)).toBe(true);
    }
  });

  it("keeps public startup validation ahead of the rest of environment validation", async () => {
    const source = await readFile("src/mcp/httpServer.ts", "utf8");
    const validationIndex = source.indexOf(
      "validatePublicServerAdminConfiguration(process.env)",
    );

    expect(validationIndex).toBeGreaterThan(-1);
    // The rest of environment validation is the centralized deployment
    // validator (issue #155); the admin guard must still run ahead of it.
    const deploymentValidationIndex = source.indexOf(
      "assertValidDeploymentConfig(process.env, 'server')",
    );
    expect(deploymentValidationIndex).toBeGreaterThan(-1);
    expect(validationIndex).toBeLessThan(deploymentValidationIndex);
  });

  it("classifies coupled feature flags", async () => {
    const { findCoupledFeatureFlagWarnings, ADMIN_COUPLED_FEATURE_FLAGS } =
      await import("../../../src/admin/config.js");

    expect([...ADMIN_COUPLED_FEATURE_FLAGS]).toEqual([
      "JIT_PURCHASE_ENABLED",
      "IMAGE_TRIAL_ENABLED",
    ]);

    expect(findCoupledFeatureFlagWarnings({})).toEqual([]);
    expect(
      findCoupledFeatureFlagWarnings({
        JIT_PURCHASE_ENABLED: "false",
        IMAGE_TRIAL_ENABLED: "false",
      }),
    ).toEqual([]);
    expect(
      findCoupledFeatureFlagWarnings({
        JIT_PURCHASE_ENABLED: "true",
        IMAGE_TRIAL_ENABLED: "true",
      }),
    ).toEqual(["JIT_PURCHASE_ENABLED", "IMAGE_TRIAL_ENABLED"]);
  });

  describe("boot validation with coupled feature flags enabled", () => {
    const OWNED_KEYS = [
      "JIT_PURCHASE_ENABLED",
      "IMAGE_TRIAL_ENABLED",
      "ADMIN_ENABLED",
      "LETTER_IRL_REQUIRE_AUTH",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "DATABASE_URL",
    ] as const;

    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      saved = Object.fromEntries(
        OWNED_KEYS.map((key) => [key, process.env[key]]),
      );

      // LETTER_IRL_REQUIRE_AUTH is read into a module constant at import time,
      // so it must be set before the dynamic import below. Disabling it also
      // suppresses the unrelated CIMD startup warning, which is the other
      // console.warn in this file — the spy therefore observes the coupling
      // warning alone rather than passing on the wrong call.
      process.env.LETTER_IRL_REQUIRE_AUTH = "false";
      process.env.DATABASE_URL = "postgres://localhost/letterirl_test";
      process.env.STRIPE_SECRET_KEY = "sk_test_boot_validation_fixture";
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_boot_validation_fixture";
      delete process.env.ADMIN_ENABLED;
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    });

    async function loadBootValidation() {
      vi.resetModules();
      const module = await import("../../../src/mcp/httpServer.js");
      return module.validateEnvironment;
    }

    it("emits the coupling warning and does not throw", async () => {
      process.env.JIT_PURCHASE_ENABLED = "true";
      process.env.IMAGE_TRIAL_ENABLED = "true";

      const validateEnvironment = await loadBootValidation();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      // The real boot path, not the pure detector. If the coupling check is
      // ever rewritten as a throw, this fails.
      expect(() => validateEnvironment()).not.toThrow();

      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain("JIT_PURCHASE_ENABLED=true");
      expect(messages[1]).toContain("IMAGE_TRIAL_ENABLED=true");
      for (const message of messages) {
        expect(message).toContain("operator recovery is unreachable");
        expect(message).toContain(
          "docs/deployment.md#operator-recovery-interaction",
        );
      }
      warn.mockRestore();
    });

    it("stays silent when the coupled flags are disabled", async () => {
      process.env.JIT_PURCHASE_ENABLED = "false";
      process.env.IMAGE_TRIAL_ENABLED = "false";

      const validateEnvironment = await loadBootValidation();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => validateEnvironment()).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("still refuses ADMIN_ENABLED=true, proving this is the real boot path", async () => {
      // Negative control. Without it, `not.toThrow()` above could be green
      // because the imported function is not the one that guards startup.
      process.env.ADMIN_ENABLED = "true";

      const validateEnvironment = await loadBootValidation();
      expect(() => validateEnvironment()).toThrowError(
        expect.objectContaining({ code: "ADMIN_LEGACY_ROUTES_DISABLED" }),
      );
    });
  });

  it("documents the coupling between the admin denial and the JIT flags", async () => {
    const deployment = await readFile("docs/deployment.md", "utf8");
    const manual = await readFile("docs/manual-tests.md", "utf8");

    expect(deployment).toContain("### Operator recovery interaction");
    for (const flag of ["JIT_PURCHASE_ENABLED", "IMAGE_TRIAL_ENABLED"]) {
      expect(deployment).toContain(flag);
      expect(manual).toContain(flag);
    }
    expect(deployment).toContain("/api/admin/image-generation/*");
    expect(manual).toContain("/api/admin/image-generation/*");
  });

  it("removes legacy launch commands while retaining explicit grant provisioning", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    expect(packageJson.scripts.admin).toBeUndefined();
    expect(packageJson.scripts["admin:dev"]).toBeUndefined();
    expect(packageJson.scripts["admin:provision-access"]).toBe(
      "tsx scripts/provisionAdminDatabaseAccess.ts",
    );
  });
});

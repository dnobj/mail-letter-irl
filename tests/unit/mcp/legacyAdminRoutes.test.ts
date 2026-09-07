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

    // The legacy dispatch and the panel file serving are gone from this
    // process; the guard is the only thing that still knows the paths.
    expect(source).not.toContain("handleAdminApiRequest");
    expect(source).not.toContain("admin-panel.html");
    expect(source).not.toContain("startsWith('/api/admin')");
  });

  it("keeps the guard exactly as wide as the deleted dispatcher's /api/admin prefix", async () => {
    const guardSource = await readFile("src/mcp/legacyAdminRoutes.ts", "utf8");
    expect(guardSource).toContain('pathname.startsWith("/api/admin")');
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

  describe("boot validation", () => {
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

    it("still refuses ADMIN_ENABLED=true through the real boot path", async () => {
      // A stale variable from the legacy panel must never come back as a
      // silent no-op: the public server refuses to start.
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
    // The recovery that used to sit behind the denied routes is documented as
    // living in the tailnet admin panel, and the dead route is no longer
    // presented as a procedure.
    expect(deployment).toContain("admin-panel-guide.md");
    expect(deployment).not.toContain("POST /api/admin/jobs/{jobId}/retry");
    expect(manual).toContain("/api/admin/image-generation/*");
  });

  it("keeps the legacy launch command gone and points the admin scripts at the tailnet panel", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    // The legacy dashboard (port 8788, ADMIN_ENABLED) has no launcher. The
    // replacement scripts start dist/admin/server.js, which never reads
    // ADMIN_ENABLED and never binds a public interface for its routes.
    expect(packageJson.scripts.admin).toBeUndefined();
    expect(packageJson.scripts["admin:start"]).toBe("node dist/admin/server.js");
    expect(packageJson.scripts["admin:dev"]).toContain("node dist/admin/server.js");
    for (const script of Object.values(packageJson.scripts as Record<string, string>)) {
      expect(script).not.toContain("ADMIN_ENABLED");
      expect(script).not.toContain("8788");
    }
    expect(packageJson.scripts["admin:provision-access"]).toBe(
      "tsx scripts/provisionAdminDatabaseAccess.ts",
    );
  });
});

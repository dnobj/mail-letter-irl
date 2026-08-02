import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

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

    // Both legacy dispatch sites match on the bare prefix. If either narrows or
    // widens, the guard must move with it or a public path slips through.
    expect(httpServerSource).toContain("url.pathname.startsWith('/api/admin')");
    expect(handlerSource).toContain("pathname.startsWith('/api/admin')");
    expect(guardSource).toContain('pathname.startsWith("/api/admin")');

    // Any path the dispatcher would accept must also be denied by the guard.
    const dispatcherAccepts = (pathname: string) =>
      pathname.startsWith("/api/admin");
    for (const pathname of [
      "/api/admin",
      "/api/admin/",
      "/api/admin/users",
      "/api/adminfoo",
      "/api/admin-panel",
      "/api/administrator",
      "/api/admin/image-generation/ambiguous",
    ]) {
      expect(dispatcherAccepts(pathname)).toBe(true);
      expect(isLegacyPublicAdminPath(pathname)).toBe(true);
    }
  });

  it("keeps public startup validation ahead of the rest of environment validation", async () => {
    const source = await readFile("src/mcp/httpServer.ts", "utf8");
    const validationIndex = source.indexOf(
      "validatePublicServerAdminConfiguration(process.env)",
    );

    expect(validationIndex).toBeGreaterThan(-1);
    expect(validationIndex).toBeLessThan(
      source.indexOf("const missing: string[] = []"),
    );
  });

  it("warns without throwing when a coupled feature flag is enabled", async () => {
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

    // The detector must never be wired to a throw: a flag combination must not
    // be able to boot-loop a running deployment.
    expect(() =>
      findCoupledFeatureFlagWarnings({ JIT_PURCHASE_ENABLED: "true" }),
    ).not.toThrow();

    const source = await readFile("src/mcp/httpServer.ts", "utf8");
    expect(source).toContain("findCoupledFeatureFlagWarnings(process.env)");
    expect(source).toContain("console.warn(");
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

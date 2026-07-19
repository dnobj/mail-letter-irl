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
  ])("returns a no-store 404 for %s before any legacy dispatch", (pathname) => {
    const { response, headers, end } = createResponse();

    expect(denyLegacyPublicAdminRoute(pathname, response)).toBe(true);
    expect(response.statusCode).toBe(404);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.has("access-control-allow-origin")).toBe(false);
    expect(end).toHaveBeenCalledWith("Not found");
  });

  it.each([
    "/",
    "/healthz",
    "/api/credits",
    "/api/administrator",
    "/administrator",
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
    expect(guardIndex).toBeLessThan(
      source.indexOf("url.pathname.startsWith('/api/admin/')"),
    );
    expect(guardIndex).toBeLessThan(
      source.indexOf("handleAdminApiRequest(req, res"),
    );
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

import type { ServerResponse } from "node:http";

export function isLegacyPublicAdminPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/admin.html" ||
    pathname === "/admin-panel.html" ||
    // Must be exactly as wide as the legacy dispatcher predicate in
    // httpServer.ts and adminApiHandler.ts, which both use
    // startsWith('/api/admin'). A narrower guard here would let a path such as
    // /api/adminfoo reach the admin-tier rate limiter and the admin request
    // boundary, leaking a distinguishable response and a public rate-limit
    // bucket even though no admin function is reachable.
    pathname.startsWith("/api/admin")
  );
}

export function denyLegacyPublicAdminRoute(
  pathname: string,
  response: ServerResponse,
): boolean {
  if (!isLegacyPublicAdminPath(pathname)) {
    return false;
  }

  response.statusCode = 404;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end("Not found");
  return true;
}

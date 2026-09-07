import type { ServerResponse } from "node:http";

export function isLegacyPublicAdminPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/admin.html" ||
    pathname === "/admin-panel.html" ||
    // Exactly as wide as the deleted legacy dispatcher's startsWith('/api/admin')
    // predicate, kept so that no /api/admin* path can ever reach another handler
    // or a distinguishable response. The replacement operator surface is the
    // tailnet-only admin service (docs/admin-panel-guide.md), never this server.
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

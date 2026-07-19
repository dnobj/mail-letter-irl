import type { ServerResponse } from "node:http";

export function isLegacyPublicAdminPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/admin.html" ||
    pathname === "/admin-panel.html" ||
    pathname === "/api/admin" ||
    pathname.startsWith("/api/admin/")
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

import { getOAuthConfig } from "./oauthConfig.js";

export type OAuthRouteKind =
  | "protected-resource"
  | "authorization-server-proxy"
  | "static-registration"
  | "none";

export function classifyOAuthRoute(
  pathname: string,
  method: string,
  mcpPath = process.env.LETTER_IRL_MCP_PATH ?? "/mcp"
): OAuthRouteKind {
  const config = getOAuthConfig();
  const protectedRoute =
    process.env.LETTER_IRL_PROTECTED_RESOURCE_ROUTE ??
    "/.well-known/oauth-protected-resource";
  const openIdRoute =
    process.env.LETTER_IRL_OPENID_ROUTE ?? "/.well-known/openid-configuration";
  const authorizationServerRoute =
    process.env.LETTER_IRL_AUTH_SERVER_ROUTE ??
    "/.well-known/oauth-authorization-server";
  const protectedRoutes = [
    protectedRoute,
    `${protectedRoute}${mcpPath}`
  ];
  if (method === "GET" && protectedRoutes.includes(pathname)) {
    return "protected-resource";
  }

  const proxyRoutes = [
    openIdRoute,
    `${openIdRoute}${mcpPath}`,
    authorizationServerRoute,
    `${authorizationServerRoute}${mcpPath}`
  ];
  if (
    method === "GET" &&
    proxyRoutes.includes(pathname) &&
    config.staticDcrCompatibility
  ) {
    return "authorization-server-proxy";
  }

  if (
    method === "POST" &&
    pathname === "/oauth/register" &&
    config.staticDcrCompatibility &&
    config.staticClientId
  ) {
    return "static-registration";
  }
  return "none";
}

import type { AuthInfo } from "@modelcontextprotocol/server";
import type { AuthenticatedUser } from "../auth/tokenValidator.js";

/**
 * What /mcp does before SDK v2's handler sees a request (#477). The handler validates no Host, no Origin and no
 * token by design, so what SDK v1's transport checked is checked here, with the same lists and the same answers.
 */

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A 403 as SDK v1's transport wrote it: a JSON-RPC error with no id. */
export type HostOrOriginRefusal = { reason: "host" | "origin"; body: { jsonrpc: "2.0"; error: { code: number; message: string }; id: null } };

/**
 * The Host must be on the list, and an Origin, when there is one, too: no Origin means a server-side client, which
 * every MCP backend is. Exact strings, as v1 compared them (a Host carries its port).
 */
export function hostOrOriginRefusal(headers: Headers, allowedHosts: readonly string[], allowedOrigins: readonly string[]): HostOrOriginRefusal | null {
  const refuse = (reason: "host" | "origin", message: string): HostOrOriginRefusal => ({
    reason,
    body: { jsonrpc: "2.0", error: { code: -32000, message }, id: null }
  });
  const host = header(headers, "host");
  if (allowedHosts.length > 0 && (!host || !allowedHosts.includes(host))) return refuse("host", `Invalid Host header: ${host}`);
  const origin = header(headers, "origin");
  if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) return refuse("origin", `Invalid Origin header: ${origin}`);
  return null;
}

/** Our signed-in caller, in the SDK's words, so the server factory can be handed it. */
export function toSdkAuthInfo(user: AuthenticatedUser): AuthInfo {
  const clientId = user.claims.azp ?? user.claims.client_id;
  return {
    token: user.token,
    clientId: typeof clientId === "string" ? clientId : "",
    scopes: user.scopes,
    extra: { user }
  };
}

/** The caller toSdkAuthInfo handed over, or null when there was none. */
export function userFromSdkAuthInfo(info: AuthInfo | undefined): AuthenticatedUser | null {
  const user = info?.extra?.user;
  return user && typeof user === "object" && typeof (user as AuthenticatedUser).userId === "string" ? (user as AuthenticatedUser) : null;
}

/** A body that is not JSON, answered as JSON-RPC says, where v1 answered 500. */
export const PARSE_ERROR_BODY = { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null } as const;

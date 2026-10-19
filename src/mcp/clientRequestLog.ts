import { writeDiagnostic } from "../utils/diagnosticLog.js";
import type { ClientProfileName } from "../auth/clientProfiles.js";
import { STEERING_COPY_REV } from "./steeringRev.js";
import { WIDGET_TEMPLATE_VERSION } from "./widgetUris.js";

/**
 * Client-request observability for the MCP endpoint (issue #235).
 *
 * The native ChatGPT mobile apps cache tool metadata and widget templates
 * far more aggressively than web, and nothing client-side reveals what a
 * given device holds. These logs answer that from the server: every
 * tools/list records the metadata revisions it SERVED plus a coarse client
 * class, so "did the phone refetch after the deploy, and what did it get?"
 * becomes a log query instead of a guess.
 *
 * Privacy: fixed event name, fixed-vocabulary fields only (CIMD-08). The
 * method is clamped to a known protocol set, tool names outside our registry
 * collapse to "other", and resource URIs are logged only when they are our
 * own ui:// template identifiers. Raw user agents are never logged - only
 * the coarse class. The app is logged as its profile name (#473), never as
 * its client id.
 */

const LOGGED_METHODS = new Set([
  "initialize",
  // The 2026-07-28 revision's own (#477): a client that asks for them speaks it.
  "server/discover",
  "subscriptions/listen",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list"
]);

export type ClientClass = "web" | "android-app" | "ios-app" | "other";

export function classifyClient(userAgent: string | undefined): ClientClass {
  if (!userAgent) {
    return "other";
  }
  // Browsers (including Chrome on Android / Safari on iOS) all send Mozilla/.
  // The native apps use platform HTTP stacks instead, so the Mozilla check
  // must run first or mobile-web traffic would be misclassified as an app.
  if (/mozilla\//i.test(userAgent)) {
    return "web";
  }
  if (/android|okhttp/i.test(userAgent)) {
    return "android-app";
  }
  if (/iphone|ipad|ios|darwin|cfnetwork/i.test(userAgent)) {
    return "ios-app";
  }
  return "other";
}

type JsonRpcish = {
  method?: unknown;
  params?: { name?: unknown; uri?: unknown; protocolVersion?: unknown; _meta?: Record<string, unknown> };
};

/** Where a 2026-07-28 request names its revision: in every request's _meta. */
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

/**
 * The protocol revision a message speaks (#477), as a date or a fixed word: a 2025-era client names it in initialize
 * and then in the MCP-Protocol-Version header, a 2026-07-28 one in every request's _meta. "none" when nothing says;
 * "other" for anything that is not a revision date, so no client text reaches the log.
 */
export function protocolVersionOf(message: JsonRpcish, header: string | undefined): string {
  const named = message.params?._meta?.[PROTOCOL_VERSION_META_KEY] ?? message.params?.protocolVersion ?? header;
  if (named === undefined || named === "") return "none";
  return typeof named === "string" && /^\d{4}-\d{2}-\d{2}$/.test(named) ? named : "other";
}

export function logMcpClientRequests(
  parsedBody: unknown,
  userAgent: string | undefined,
  knownToolNames: ReadonlySet<string>,
  client?: ClientProfileName,
  protocolHeader?: string
): void {
  const messages: JsonRpcish[] = Array.isArray(parsedBody)
    ? (parsedBody as JsonRpcish[])
    : parsedBody && typeof parsedBody === "object"
      ? [parsedBody as JsonRpcish]
      : [];

  for (const message of messages) {
    const method = typeof message.method === "string" ? message.method : undefined;
    if (!method || !LOGGED_METHODS.has(method)) {
      continue;
    }

    const fields: Record<string, string | number> = {
      rpcMethod: method,
      clientClass: classifyClient(userAgent),
      protocolVersion: protocolVersionOf(message, protocolHeader)
    };
    if (client) {
      fields.client = client;
    }

    if (method === "tools/list") {
      // Record what this response will serve, so a later behavioral question
      // ("which copy did that device have?") is answerable from the log line.
      fields.steeringRev = STEERING_COPY_REV;
      fields.widgetTemplateVersion = WIDGET_TEMPLATE_VERSION;
    } else if (method === "tools/call") {
      const name = message.params?.name;
      fields.toolName =
        typeof name === "string" && knownToolNames.has(name) ? name : "other";
    } else if (method === "resources/read") {
      const uri = message.params?.uri;
      if (typeof uri === "string" && uri.startsWith("ui://")) {
        fields.resourceUri = uri;
      }
    }

    writeDiagnostic("info", "mcp.client_request", fields);
  }
}

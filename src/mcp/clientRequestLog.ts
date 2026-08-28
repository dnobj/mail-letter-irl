import { writeDiagnostic } from "../utils/diagnosticLog.js";
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
 * the coarse class.
 */

const LOGGED_METHODS = new Set([
  "initialize",
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

type JsonRpcish = { method?: unknown; params?: { name?: unknown; uri?: unknown } };

export function logMcpClientRequests(
  parsedBody: unknown,
  userAgent: string | undefined,
  knownToolNames: ReadonlySet<string>
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
      clientClass: classifyClient(userAgent)
    };

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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyClient, logMcpClientRequests } from "../../../src/mcp/clientRequestLog.js";
import { STEERING_COPY_REV } from "../../../src/mcp/steeringRev.js";
import { WIDGET_TEMPLATE_VERSION } from "../../../src/mcp/widgetUris.js";
import * as diagnostics from "../../../src/utils/diagnosticLog.js";

describe("classifyClient", () => {
  it.each([
    // Browsers all lead with Mozilla/, including mobile browsers - the web
    // check must win even when the UA also names a mobile OS.
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/127.0", "web"],
    ["Mozilla/5.0 (Linux; Android 16; SM-S948U) Chrome/127 Mobile", "web"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/605.1", "web"],
    ["ChatGPT/1.2026.220 (Android 16; SM-S948U)", "android-app"],
    ["okhttp/4.12.0", "android-app"],
    ["ChatGPT/1.2026.219 (iOS 19.0; iPhone17,1)", "ios-app"],
    ["com.openai.chat/1.2026.219 CFNetwork/1568 Darwin/24.0", "ios-app"],
    ["curl/8.9.1", "other"],
    [undefined, "other"]
  ] as const)("classifies %s as %s", (userAgent, expected) => {
    expect(classifyClient(userAgent as string | undefined)).toBe(expected);
  });
});

describe("logMcpClientRequests", () => {
  const knownTools = new Set(["generate_image_fallback", "upload_image"]);
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(diagnostics, "writeDiagnostic").mockImplementation(() => {});
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("logs tools/list with the served metadata revisions", () => {
    logMcpClientRequests(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "ChatGPT/1.2026.220 (Android 16)",
      knownTools
    );
    expect(writeSpy).toHaveBeenCalledWith("info", "mcp.client_request", {
      rpcMethod: "tools/list",
      clientClass: "android-app",
      steeringRev: STEERING_COPY_REV,
      widgetTemplateVersion: WIDGET_TEMPLATE_VERSION
    });
  });

  it("logs tools/call with registry names and collapses unknown names", () => {
    logMcpClientRequests(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "generate_image_fallback" } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "totally_made_up" } }
      ],
      "Mozilla/5.0",
      knownTools
    );
    expect(writeSpy).toHaveBeenNthCalledWith(1, "info", "mcp.client_request", {
      rpcMethod: "tools/call",
      clientClass: "web",
      toolName: "generate_image_fallback"
    });
    expect(writeSpy).toHaveBeenNthCalledWith(2, "info", "mcp.client_request", {
      rpcMethod: "tools/call",
      clientClass: "web",
      toolName: "other"
    });
  });

  it("logs resources/read uris only for our ui:// templates", () => {
    logMcpClientRequests(
      [
        { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://widgets/GenerateImageCard.html@v3" } },
        { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "https://evil.example/x" } }
      ],
      undefined,
      knownTools
    );
    expect(writeSpy).toHaveBeenNthCalledWith(1, "info", "mcp.client_request", {
      rpcMethod: "resources/read",
      clientClass: "other",
      resourceUri: "ui://widgets/GenerateImageCard.html@v3"
    });
    expect(writeSpy).toHaveBeenNthCalledWith(2, "info", "mcp.client_request", {
      rpcMethod: "resources/read",
      clientClass: "other"
    });
  });

  it("ignores notifications, unknown methods, and non-object bodies", () => {
    logMcpClientRequests({ method: "notifications/initialized" }, "x", knownTools);
    logMcpClientRequests("tools/list", "x", knownTools);
    logMcpClientRequests(undefined, "x", knownTools);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

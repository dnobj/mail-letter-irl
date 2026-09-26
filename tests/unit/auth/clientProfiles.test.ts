import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callingApp,
  CLIENT_PROFILE_NAMES,
  clientIdOf,
  clientLogFields,
  clientProfileNamed,
  resolveClientProfile,
  type ClientProfileName
} from "../../../src/auth/clientProfiles.js";
import type { AuthenticatedUser } from "../../../src/auth/tokenValidator.js";

function jwt(claims: Record<string, unknown>): AuthenticatedUser {
  return {
    userId: "auth0|user",
    claims,
    token: "redacted",
    authType: "jwt",
    scopes: []
  };
}

function pat(claims: Record<string, unknown> = {}): AuthenticatedUser {
  return {
    userId: "auth0|user",
    claims: { authType: "pat", ...claims },
    token: "redacted",
    authType: "pat",
    scopes: []
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveClientProfile (#473)", () => {
  it.each([
    ["https://claude.ai/oauth/mcp-oauth-client-metadata", "claude"],
    ["https://claude.ai/oauth/claude-code-client-metadata", "claude_code"],
    ["https://vscode.dev/oauth/client-metadata.json", "vscode"],
    [
      "https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json",
      "hermes"
    ],
    ["https://chatgpt.com/oauth/client.json", "chatgpt"],
    // ChatGPT's per-callback document, the one it uses against our Auth0.
    ["https://chatgpt.com/oauth/AbC123_-x/client.json", "chatgpt"],
    ["https://chatgpt.com/oauth/codex/IJMOsCBL6i7U/client.json", "codex"],
    // Fits the ChatGPT pattern too; the exact list has to win.
    ["https://chatgpt.com/oauth/codex/client.json", "codex"]
  ] as const)("recognises %s as %s", (clientId, expected) => {
    expect(resolveClientProfile(jwt({ azp: clientId })).name).toBe(expected);
  });

  it.each([
    "https://chatgpt.com.evil.example/oauth/abc/client.json",
    // A document elsewhere that merely embeds ChatGPT's address.
    "https://evil.example/?next=https://chatgpt.com/oauth/abc/client.json",
    "https://evil.example/?next=https://chatgpt.com/oauth/codex/abc/client.json",
    "http://chatgpt.com/oauth/abc/client.json",
    "https://chatgpt.com/oauth/abc/client.json?x=1",
    "https://chatgpt.com/oauth/a/b/client.json",
    "https://chatgpt.com/oauth//client.json",
    // Each pattern's anchors and escaped dots, one lookalike apiece.
    "https://chatgptXcom/oauth/abc/client.json",
    "https://chatgpt.com/oauth/abc/clientXjson",
    "https://chatgpt.com/oauth/codex/abc/client.json?x=1",
    "https://chatgpt.com/oauth/codex//client.json",
    "https://chatgptXcom/oauth/codex/abc/client.json",
    "https://chatgpt.com/oauth/codex/abc/clientXjson",
    "https://claude.ai/oauth/mcp-oauth-client-metadata/",
    "HTTPS://CLAUDE.AI/oauth/mcp-oauth-client-metadata",
    "a1B2c3D4e5F6g7H8i9J0",
    ""
  ])("treats %j as an app it does not know", (clientId) => {
    expect(resolveClientProfile(jwt({ azp: clientId })).name).toBe("generic");
  });

  it("prefers client_id to azp, trims both, and ignores non-strings", () => {
    const claude = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    const vscode = "https://vscode.dev/oauth/client-metadata.json";
    expect(resolveClientProfile(jwt({ client_id: claude, azp: vscode })).name).toBe("claude");
    expect(resolveClientProfile(jwt({ client_id: `  ${vscode} ` })).name).toBe("vscode");
    expect(resolveClientProfile(jwt({ client_id: 42, azp: claude })).name).toBe("claude");
    expect(resolveClientProfile(jwt({ client_id: "   ", azp: claude })).name).toBe("claude");
    expect(clientIdOf(jwt({ client_id: ["x"] }))).toBeUndefined();
  });

  it("does not fall back to azp when client_id names an app it does not know", () => {
    expect(
      resolveClientProfile(
        jwt({ client_id: "tpc_x", azp: "https://chatgpt.com/oauth/abc/client.json" })
      ).name
    ).toBe("generic");
  });

  it("names a personal access token 'token', whatever it carries", () => {
    expect(resolveClientProfile(pat()).name).toBe("token");
    expect(
      resolveClientProfile(pat({ azp: "https://chatgpt.com/oauth/abc/client.json" })).name
    ).toBe("token");
    expect(clientIdOf(pat({ azp: "https://chatgpt.com/oauth/abc/client.json" }))).toBeUndefined();
  });

  it("treats no authentication as an app it does not know", () => {
    expect(resolveClientProfile(null).name).toBe("generic");
    expect(resolveClientProfile(jwt({})).name).toBe("generic");
  });

  it("recognises ChatGPT's static rollback client, only while rollback mode is on (#20)", () => {
    const client = jwt({ azp: "StAtIcClIeNtId0123" });
    expect(resolveClientProfile(client).name).toBe("generic");
    vi.stubEnv("CHATGPT_STATIC_CLIENT_ID", "  StAtIcClIeNtId0123  ");
    // Configured, but rollback mode is off: /oauth/register is not handing
    // the id to anyone, so it is not ChatGPT's.
    expect(resolveClientProfile(client).name).toBe("generic");
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    expect(resolveClientProfile(client).name).toBe("chatgpt");
    expect(resolveClientProfile(jwt({ azp: "SomeOtherClient" })).name).toBe("generic");
  });

  it.each(["", "   "])("matches no client with a blank static id %j", (value) => {
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    vi.stubEnv("CHATGPT_STATIC_CLIENT_ID", value);
    expect(resolveClientProfile(jwt({ azp: "AnyClient" })).name).toBe("generic");
  });

  // The trust table is the security boundary for the send rule (#470). A flag
  // turned on here must be a decision made after a live test, so this pins it.
  it("trusts only ChatGPT with cards, card-only tools, purchases and its own images", () => {
    const expected: Record<ClientProfileName, [boolean, boolean, boolean, boolean]> = {
      chatgpt: [true, true, true, true],
      claude: [false, false, false, false],
      claude_code: [false, false, false, false],
      codex: [false, false, false, false],
      vscode: [false, false, false, false],
      hermes: [false, false, false, false],
      token: [false, false, false, false],
      generic: [false, false, false, false]
    };
    const samples: Record<ClientProfileName, AuthenticatedUser | null> = {
      chatgpt: jwt({ azp: "https://chatgpt.com/oauth/abc/client.json" }),
      claude: jwt({ azp: "https://claude.ai/oauth/mcp-oauth-client-metadata" }),
      claude_code: jwt({ azp: "https://claude.ai/oauth/claude-code-client-metadata" }),
      codex: jwt({ azp: "https://chatgpt.com/oauth/codex/abc/client.json" }),
      vscode: jwt({ azp: "https://vscode.dev/oauth/client-metadata.json" }),
      hermes: jwt({
        azp: "https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json"
      }),
      token: pat(),
      generic: null
    };
    for (const [name, flags] of Object.entries(expected) as [
      ClientProfileName,
      [boolean, boolean, boolean, boolean]
    ][]) {
      const profile = resolveClientProfile(samples[name]);
      expect(profile.name).toBe(name);
      expect([
        profile.rendersCards,
        profile.honorsCardOnlyTools,
        profile.inAppPurchases,
        profile.generatesImages
      ]).toEqual(flags);
      // The same profile by name, for text written for one app on purpose.
      expect(clientProfileNamed(name)).toBe(profile);
    }
    expect([...CLIENT_PROFILE_NAMES].sort()).toEqual(Object.keys(expected).sort());
  });

  it("answers a tool context that names no app as an app that trusts nothing (#484)", () => {
    expect(callingApp(undefined)).toBe(clientProfileNamed("generic"));
    expect(callingApp({})).toBe(clientProfileNamed("generic"));
    expect(callingApp({ client: clientProfileNamed("claude") })).toBe(clientProfileNamed("claude"));
  });
});

describe("clientLogFields (#473)", () => {
  it("logs a known app by name alone", () => {
    expect(clientLogFields(jwt({ azp: "https://claude.ai/oauth/mcp-oauth-client-metadata" }))).toEqual({
      client: "claude"
    });
    expect(clientLogFields(pat())).toEqual({ client: "token" });
  });

  it("logs only the shape of an unknown app's client id, never the id", () => {
    expect(clientLogFields(jwt({ azp: "https://new-app.example/oauth/client.json" }))).toEqual({
      client: "generic",
      clientIdKind: "url"
    });
    expect(clientLogFields(jwt({ azp: "a1B2c3D4e5F6g7H8i9J0" }))).toEqual({
      client: "generic",
      clientIdKind: "opaque"
    });
    // Auth0's own id for an imported document (tpc_...), and anything that is
    // not an https document URL from its first character, read as opaque.
    for (const azp of ["tpc_3e5dGr4xSikvNzScZkiVhd", "http://new-app.example/client.json", "x https://new-app.example"]) {
      expect(clientLogFields(jwt({ azp }))).toEqual({ client: "generic", clientIdKind: "opaque" });
    }
    expect(clientLogFields(jwt({}))).toEqual({ client: "generic", clientIdKind: "absent" });
    expect(clientLogFields(null)).toEqual({ client: "generic", clientIdKind: "absent" });
  });

  // Source-shape assertions, as in rateLimitCoverage.test.ts: the wiring is a
  // few lines of one request handler, and there is nothing to call without
  // booting the server.
  it("is written on every MCP request line that knows the caller", () => {
    const httpServer = fs.readFileSync(
      path.resolve(__dirname, "../../../src/mcp/httpServer.ts"),
      "utf-8"
    );
    expect(httpServer).toMatch(
      /const clientFields = clientLogFields\(authInfo\);[\s\S]{0,300}?writeDiagnostic\("info", "mcp\.request_received", \{[^}]*\.\.\.clientFields\s*\}\);/
    );
    expect(httpServer).toMatch(
      /writeDiagnostic\("info", "mcp\.sse_session_established", \{[^}]*\.\.\.clientLogFields\(authInfo\)\s*\}\);/
    );
    expect(httpServer).toMatch(
      /logMcpClientRequests\(\s*parsedBody,\s*req\.headers\["user-agent"\],\s*cachedToolNames \?\? new Set\(\),\s*clientFields\.client\s*\);/
    );
  });
});

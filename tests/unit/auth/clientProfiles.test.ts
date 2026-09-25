import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientIdOf,
  clientLogFields,
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
    "http://chatgpt.com/oauth/abc/client.json",
    "https://chatgpt.com/oauth/abc/client.json?x=1",
    "https://chatgpt.com/oauth/a/b/client.json",
    "https://chatgpt.com/oauth//client.json",
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

  it("recognises ChatGPT's static rollback client from its configured id (#20)", () => {
    const client = jwt({ azp: "StAtIcClIeNtId0123" });
    expect(resolveClientProfile(client).name).toBe("generic");
    vi.stubEnv("CHATGPT_STATIC_CLIENT_ID", "StAtIcClIeNtId0123");
    expect(resolveClientProfile(client).name).toBe("chatgpt");
    expect(resolveClientProfile(jwt({ azp: "SomeOtherClient" })).name).toBe("generic");
  });

  // The trust table is the security boundary for the send rule (#470). A flag
  // turned on here must be a decision made after a live test, so this pins it.
  it("trusts only ChatGPT with cards, card-only tools and purchases", () => {
    const expected: Record<ClientProfileName, [boolean, boolean, boolean]> = {
      chatgpt: [true, true, true],
      claude: [false, false, false],
      claude_code: [false, false, false],
      codex: [false, false, false],
      vscode: [false, false, false],
      hermes: [false, false, false],
      token: [false, false, false],
      generic: [false, false, false]
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
      [boolean, boolean, boolean]
    ][]) {
      const profile = resolveClientProfile(samples[name]);
      expect(profile.name).toBe(name);
      expect([profile.rendersCards, profile.honorsCardOnlyTools, profile.inAppPurchases]).toEqual(
        flags
      );
    }
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
    expect(clientLogFields(jwt({}))).toEqual({ client: "generic", clientIdKind: "absent" });
    expect(clientLogFields(null)).toEqual({ client: "generic", clientIdKind: "absent" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { getOAuthConfig, validateOAuthConfig } from "../../../src/auth/oauthConfig.js";

describe("temporary static-registration rollback", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is disabled by default even when an old client ID remains configured", () => {
    vi.stubEnv("CHATGPT_STATIC_CLIENT_ID", "legacy-client");
    expect(getOAuthConfig().staticDcrCompatibility).toBe(false);
  });

  it("requires an explicit flag and static client ID", () => {
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    const config = getOAuthConfig();
    expect(config.staticDcrCompatibility).toBe(true);
    expect(validateOAuthConfig(config)).toContain(
      "CHATGPT_STATIC_CLIENT_ID is required when static DCR compatibility is enabled"
    );
    expect(validateOAuthConfig(config)).toContain(
      "CHATGPT_STATIC_REDIRECT_URIS is required when static DCR compatibility is enabled"
    );
  });

  it("uses an explicit rollback redirect inventory", () => {
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    vi.stubEnv("CHATGPT_STATIC_CLIENT_ID", "legacy-client");
    vi.stubEnv(
      "CHATGPT_STATIC_REDIRECT_URIS",
      "https://chatgpt.com/connector/oauth/current-callback http://localhost:18883/oauth/callback"
    );

    expect(getOAuthConfig().staticRedirectUris).toEqual([
      "https://chatgpt.com/connector/oauth/current-callback",
      "http://localhost:18883/oauth/callback"
    ]);
  });

  it("no longer widens the accepted audiences in rollback mode", () => {
    // The legacy audience merge is gone: a LETTER_IRL_OAUTH_LEGACY_AUDIENCES
    // left behind in an environment changes nothing, flag on or off.
    vi.stubEnv("LETTER_IRL_OAUTH_AUDIENCE", "https://dev.example.com/mcp");
    vi.stubEnv("LETTER_IRL_OAUTH_LEGACY_AUDIENCES", "https://letter-irl/api");
    expect(getOAuthConfig().audience).toEqual(["https://dev.example.com/mcp"]);

    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    expect(getOAuthConfig().audience).toEqual(["https://dev.example.com/mcp"]);
  });

  it("refuses a second audience in rollback mode too", () => {
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    vi.stubEnv(
      "LETTER_IRL_OAUTH_AUDIENCE",
      "https://dev.example.com/mcp https://letter-irl/api"
    );
    expect(validateOAuthConfig(getOAuthConfig())).toContain(
      "LETTER_IRL_OAUTH_AUDIENCE must name exactly one audience, the MCP resource"
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyOAuthRoute } from "../../../src/auth/oauthRoutes.js";

describe("OAuth route policy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps protected-resource discovery available in CIMD mode", () => {
    expect(
      classifyOAuthRoute("/.well-known/oauth-protected-resource", "GET")
    ).toBe("protected-resource");
    expect(
      classifyOAuthRoute("/.well-known/oauth-protected-resource/mcp", "GET")
    ).toBe("protected-resource");
  });

  it("does not proxy authorization-server metadata or registration in CIMD mode", () => {
    expect(
      classifyOAuthRoute("/.well-known/oauth-authorization-server", "GET")
    ).toBe("none");
    expect(classifyOAuthRoute("/oauth/register", "POST")).toBe("none");
  });

  it("restores only the compatibility routes behind the rollback flag", () => {
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    vi.stubEnv("CHATGPT_STATIC_CLIENT_ID", "legacy-client");
    expect(
      classifyOAuthRoute("/.well-known/oauth-authorization-server", "GET")
    ).toBe("authorization-server-proxy");
    expect(classifyOAuthRoute("/oauth/register", "POST")).toBe(
      "static-registration"
    );
  });
});

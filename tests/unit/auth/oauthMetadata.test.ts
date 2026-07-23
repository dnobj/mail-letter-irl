import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOpenIdConfiguration,
  getProtectedResourceMetadata
} from "../../../src/auth/metadata.js";

const issuer = "https://dev-test.auth0.com/";
const resource = "https://letter-irl-api-development.up.railway.app/mcp";

describe("OAuth metadata", () => {
  beforeEach(() => {
    vi.stubEnv("LETTER_IRL_PUBLIC_BASE_URL", resource.replace(/\/mcp$/, ""));
    vi.stubEnv("LETTER_IRL_MCP_RESOURCE", resource);
    vi.stubEnv("LETTER_IRL_OAUTH_ISSUER", issuer);
    vi.stubEnv("LETTER_IRL_OAUTH_AUTH_ENDPOINT", `${issuer}authorize`);
    vi.stubEnv("LETTER_IRL_OAUTH_TOKEN_ENDPOINT", `${issuer}oauth/token`);
    vi.stubEnv("LETTER_IRL_OAUTH_JWKS_URI", `${issuer}.well-known/jwks.json`);
    vi.stubEnv("LETTER_IRL_OAUTH_AUDIENCE", resource);
    vi.stubEnv(
      "LETTER_IRL_OAUTH_SCOPES",
      "openid profile email mail:read mail:draft mail:send"
    );
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "false");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("publishes the exact MCP resource, Auth0 issuer, and supported scopes", () => {
    expect(getProtectedResourceMetadata()).toEqual({
      resource,
      authorization_servers: [issuer],
      scopes_supported: [
        "openid",
        "profile",
        "email",
        "mail:read",
        "mail:draft",
        "mail:send"
      ]
    });
  });

  it("does not invent CIMD, registration, redirect, or confidential-client capabilities", () => {
    const metadata = getOpenIdConfiguration(resource.replace(/\/mcp$/, "")) as Record<
      string,
      unknown
    >;

    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.grant_types_supported).toEqual(["authorization_code"]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(metadata).not.toHaveProperty("client_id_metadata_document_supported");
    expect(metadata).not.toHaveProperty("registration_endpoint");
    expect(metadata).not.toHaveProperty("redirect_uris_supported");
  });

  it("advertises the static registration route only in rollback mode", () => {
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    vi.stubEnv("CHATGPT_STATIC_CLIENT_ID", "rollback-client");

    expect(
      getOpenIdConfiguration("https://dev-api.example.com").registration_endpoint
    ).toBe("https://dev-api.example.com/oauth/register");
  });
});

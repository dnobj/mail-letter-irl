import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOpenIdConfiguration,
  getProtectedResourceMetadata
} from "../../../src/auth/metadata.js";
import { SUPPORTED_GRANT_TYPES } from "../../../src/auth/oauthConfig.js";

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
      "openid profile email offline_access mail:read mail:draft mail:send"
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
        // Requested so Auth0 issues a refresh token; never demanded by a tool.
        "offline_access",
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
    // Both grants, and refresh_token for a concrete reason: this document is
    // the authorization-server metadata in static-DCR mode, and a client that
    // reads no refresh_token grant will not request offline_access, so the
    // connection dies at access-token expiry (issue #160). It must also stay
    // consistent with the /oauth/register response, which already claims both.
    expect(metadata.grant_types_supported).toEqual([...SUPPORTED_GRANT_TYPES]);
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
    expect(
      getOpenIdConfiguration("https://dev-api.example.com").issuer
    ).toBe("https://dev-api.example.com");
    expect(
      getProtectedResourceMetadata("https://dev-api.example.com")
        .authorization_servers
    ).toEqual(["https://dev-api.example.com"]);
  });
});

/**
 * The bug this guards (issue #160): the metadata document advertised
 * `["authorization_code"]` while /oauth/register simultaneously told the client
 * it could use `refresh_token`. In static-DCR mode this document is the
 * authorization-server metadata ChatGPT reads, so it took the server at its
 * word, never requested `offline_access`, and every session died at
 * access-token expiry - recoverable only by a human clicking Reconnect and
 * re-consenting, which also meant no unattended test outlived a token lifetime.
 *
 * Advertising `offline_access` in scopes_supported is necessary but not
 * sufficient: a client will not ask for a refresh token from a server that says
 * it cannot redeem one.
 */
describe("refresh-token grant advertisement (issue #160)", () => {
  it("advertises the refresh_token grant, so clients request offline_access", () => {
    expect(SUPPORTED_GRANT_TYPES).toContain("refresh_token");
    expect(SUPPORTED_GRANT_TYPES).toContain("authorization_code");
  });

  it("advertises offline_access alongside it, since one is useless without the other", () => {
    const metadata = getOpenIdConfiguration(resource.replace(/\/mcp$/, "")) as Record<
      string,
      unknown
    >;
    expect(metadata.scopes_supported).toContain("offline_access");
    expect(metadata.grant_types_supported).toContain("refresh_token");
  });
});

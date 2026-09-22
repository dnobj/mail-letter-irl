import { describe, expect, it } from "vitest";
import {
  getOAuthConfig,
  isCimdEnforcementEnabled,
  validateOAuthConfig
} from "../../../src/auth/oauthConfig.js";

function validEnv(): NodeJS.ProcessEnv {
  const issuer = "https://dev-tenant.us.auth0.com/";
  const resource = "https://letter-irl-api-development.up.railway.app/mcp";
  return {
    LETTER_IRL_DEPLOYMENT_ENVIRONMENT: "development",
    LETTER_IRL_PUBLIC_BASE_URL: resource.replace(/\/mcp$/, ""),
    LETTER_IRL_MCP_RESOURCE: resource,
    LETTER_IRL_OAUTH_ISSUER: issuer,
    LETTER_IRL_OAUTH_DEV_ISSUER: issuer,
    LETTER_IRL_OAUTH_AUTH_ENDPOINT: `${issuer}authorize`,
    LETTER_IRL_OAUTH_TOKEN_ENDPOINT: `${issuer}oauth/token`,
    LETTER_IRL_OAUTH_JWKS_URI: `${issuer}.well-known/jwks.json`,
    LETTER_IRL_OAUTH_AUDIENCE: resource,
    LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS: "RS256",
    LETTER_IRL_OAUTH_SCOPES:
      "openid profile email offline_access mail:read mail:draft mail:send"
  };
}

describe("OAuth startup validation", () => {
  it("accepts an isolated DEV configuration with exact resource and audience", () => {
    const env = validEnv();
    expect(validateOAuthConfig(getOAuthConfig(env), env)).toEqual([]);
  });

  it("accepts a complete single-audience rollback configuration", () => {
    // Rollback mode keeps the one-audience rule. This pins that a correct
    // rollback still validates, so the rule cannot quietly refuse every one.
    const env = {
      ...validEnv(),
      LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY: "true",
      CHATGPT_STATIC_CLIENT_ID: "rollback-client",
      CHATGPT_STATIC_REDIRECT_URIS: "https://chatgpt.com/connector/oauth/rollback-callback"
    };
    expect(validateOAuthConfig(getOAuthConfig(env), env)).toEqual([]);
  });

  it("rejects cross-environment issuer selection", () => {
    const env = validEnv();
    env.LETTER_IRL_OAUTH_ISSUER = "https://production-tenant.us.auth0.com/";
    expect(validateOAuthConfig(getOAuthConfig(env), env)).toContain(
      "OAuth issuer does not match the development issuer allowlist"
    );
  });

  it("rejects missing endpoints, resource, and audience", () => {
    const env = validEnv();
    delete env.LETTER_IRL_OAUTH_TOKEN_ENDPOINT;
    delete env.LETTER_IRL_MCP_RESOURCE;
    delete env.LETTER_IRL_PUBLIC_BASE_URL;
    delete env.LETTER_IRL_OAUTH_AUDIENCE;
    const errors = validateOAuthConfig(getOAuthConfig(env), env);
    expect(errors).toContain("LETTER_IRL_OAUTH_TOKEN_ENDPOINT is required");
    expect(errors).toContain("LETTER_IRL_MCP_RESOURCE is required");
    expect(errors).toContain("LETTER_IRL_OAUTH_AUDIENCE is required");
  });

  it("rejects a non-exact audience, unsafe algorithms, and missing product scopes", () => {
    const env = validEnv();
    env.LETTER_IRL_OAUTH_AUDIENCE = "https://letter-irl/api";
    env.LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS = "RS256 HS256";
    env.LETTER_IRL_OAUTH_SCOPES = "openid profile email mail:read";
    const errors = validateOAuthConfig(getOAuthConfig(env), env);
    expect(errors).toContain(
      "LETTER_IRL_OAUTH_AUDIENCE must include the exact MCP resource"
    );
    expect(errors).toContain(
      "LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS must be exactly RS256"
    );
    expect(errors).toContain("LETTER_IRL_OAUTH_SCOPES must include mail:draft");
    expect(errors).toContain("LETTER_IRL_OAUTH_SCOPES must include mail:send");
  });

  it("rejects a configuration that requests scopes it does not advertise", () => {
    // The per-tool securitySchemes ask every customer for offline_access and
    // the identity scopes. A deployment that advertises neither is the
    // #160 drift in reverse, and it bites hardest in static-DCR mode
    // where this metadata IS the document ChatGPT reads.
    const env = validEnv();
    env.LETTER_IRL_OAUTH_SCOPES = "mail:read mail:draft mail:send";
    const errors = validateOAuthConfig(getOAuthConfig(env), env);
    expect(errors).toContain("LETTER_IRL_OAUTH_SCOPES must include offline_access");
    expect(errors).toContain("LETTER_IRL_OAUTH_SCOPES must include openid");
    expect(errors).toContain("LETTER_IRL_OAUTH_SCOPES must include email");
  });

  it("rejects a development Railway resource in production", () => {
    const env = validEnv();
    env.LETTER_IRL_DEPLOYMENT_ENVIRONMENT = "production";
    env.LETTER_IRL_OAUTH_PROD_ISSUER = env.LETTER_IRL_OAUTH_ISSUER;
    expect(validateOAuthConfig(getOAuthConfig(env), env)).toContain(
      "Production MCP resource must not use a Railway development hostname"
    );
  });

  it("activates strict startup enforcement only with an explicit cutover flag", () => {
    expect(isCimdEnforcementEnabled({})).toBe(false);
    expect(
      isCimdEnforcementEnabled({ LETTER_IRL_OAUTH_CIMD_ENFORCEMENT: "true" })
    ).toBe(true);
  });
});

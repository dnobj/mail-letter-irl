/**
 * The per-tool authorization vocabulary. Every tool maps to exactly one of
 * these (src/auth/toolScopes.ts), and validateOAuthConfig requires all three to
 * be advertised. Nothing else belongs here: a scope in this list is a scope a
 * tool can demand.
 */
export const PRODUCT_SCOPES = ["mail:read", "mail:draft", "mail:send"] as const;

/**
 * Identity scopes: advertised, and since #425 asked for on every tool, so that
 * a client which honours per-tool scope tags gets an ID token. Never demanded
 * by a tool. Note what this did NOT do (#424): ChatGPT went on requesting
 * exactly the product scopes plus offline_access, read from the Auth0 grant
 * on a connector created after the deploy. ChatGPT identifies a connected
 * account through the profile tool (src/tools/getProfile.ts), not through
 * these. They stay because advertising and requesting must agree, and
 * because other MCP clients do honour the tags.
 *
 * `profile` is deliberately absent. OpenAI's Apps SDK auth guidance names
 * `openid` and `email`; `profile` is the widest OIDC scope - name, picture,
 * locale and more - and is asked for by nothing we know of. Add it only if
 * ChatGPT is shown to need a display name for its account picker, and say so
 * here when you do.
 */
export const IDENTITY_SCOPES = ["openid", "email"] as const;

/**
 * Grant types this deployment supports, advertised in authorization-server
 * metadata and echoed by the static registration response.
 *
 * These two had drifted apart: /oauth/register claimed refresh_token while
 * the metadata document advertised authorization_code alone. In static-DCR
 * mode that metadata IS the authorization-server document ChatGPT reads, so
 * it concluded refreshing was unsupported and never requested offline_access
 * - which is why every DEV session died at access-token expiry and only a
 * human re-consent brought it back (issue #160). Both call sites now read
 * this list, so they cannot disagree again.
 */
export const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

/**
 * Session scopes: requested from Auth0, never demanded by a tool.
 *
 * `offline_access` is what makes Auth0 issue a refresh token. Without it the
 * connection simply died when the access token expired - observed twice in
 * three hours on 8 Aug 2026 and again on 23 Aug - and the only recovery was a
 * human clicking Reconnect and re-consenting, which also meant no unattended
 * test of this surface could outlive a token lifetime (issue #160).
 *
 * It buys fewer prompts and costs a longer-lived grant: a refresh token
 * carrying mail:send is a standing ability to spend a customer's credits and
 * post physical mail. That exposure is bounded in the Auth0 tenant rather than
 * here - rotation on, 30-day absolute, 14-day inactivity - and the revocation
 * counter-test (CIMD-02b in docs/manual-tests.md) is what keeps it honest.
 */
export const SESSION_SCOPES = ["offline_access"] as const;

export const DEFAULT_OAUTH_SCOPES = [
  ...IDENTITY_SCOPES,
  ...SESSION_SCOPES,
  ...PRODUCT_SCOPES
];

export interface OAuthConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  resource: string;
  audience: string[];
  algorithms: string[];
  scopes: string[];
  staticDcrCompatibility: boolean;
  staticClientId?: string;
  staticRedirectUris: string[];
}

function parseList(value: string | undefined, fallback: readonly string[] = []): string[] {
  return (value ?? fallback.join(" "))
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const baseUrl = trimTrailingSlash(env.LETTER_IRL_PUBLIC_BASE_URL ?? "");
  const mcpPath = env.LETTER_IRL_MCP_PATH ?? "/mcp";
  const staticDcrCompatibility =
    env.LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY === "true";
  // One audience in every mode. LETTER_IRL_OAUTH_LEGACY_AUDIENCES used to be
  // merged in under the static-DCR flag. It began as part of that rollback (the
  // recorded legacy client and audience), and the website's tokens for the
  // retired https://letter-irl/api audience later came to depend on it. The
  // website and the REST routes moved onto the MCP audience in September 2026,
  // and a rollback token carries the /mcp audience too, because ChatGPT sends
  // the /mcp resource. Nothing needs a second audience.
  const audience = parseList(env.LETTER_IRL_OAUTH_AUDIENCE);

  return {
    issuer: env.LETTER_IRL_OAUTH_ISSUER ?? "",
    authorizationEndpoint: env.LETTER_IRL_OAUTH_AUTH_ENDPOINT ?? "",
    tokenEndpoint: env.LETTER_IRL_OAUTH_TOKEN_ENDPOINT ?? "",
    jwksUri: env.LETTER_IRL_OAUTH_JWKS_URI ?? "",
    resource: env.LETTER_IRL_MCP_RESOURCE ?? (baseUrl ? `${baseUrl}${mcpPath}` : ""),
    audience: [...new Set(audience)],
    algorithms: parseList(env.LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS, ["RS256"]),
    scopes: parseList(env.LETTER_IRL_OAUTH_SCOPES, DEFAULT_OAUTH_SCOPES),
    staticDcrCompatibility,
    staticClientId: env.CHATGPT_STATIC_CLIENT_ID,
    staticRedirectUris: parseList(env.CHATGPT_STATIC_REDIRECT_URIS)
  };
}

function requireHttpsUrl(name: string, value: string, errors: string[]): URL | undefined {
  if (!value) {
    errors.push(`${name} is required`);
    return undefined;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      errors.push(`${name} must use HTTPS`);
    }
    return parsed;
  } catch {
    errors.push(`${name} must be a valid URL`);
    return undefined;
  }
}

export function validateOAuthConfig(
  config: OAuthConfig,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const errors: string[] = [];
  const issuerUrl = requireHttpsUrl("LETTER_IRL_OAUTH_ISSUER", config.issuer, errors);
  const authUrl = requireHttpsUrl(
    "LETTER_IRL_OAUTH_AUTH_ENDPOINT",
    config.authorizationEndpoint,
    errors
  );
  const tokenUrl = requireHttpsUrl(
    "LETTER_IRL_OAUTH_TOKEN_ENDPOINT",
    config.tokenEndpoint,
    errors
  );
  const jwksUrl = requireHttpsUrl("LETTER_IRL_OAUTH_JWKS_URI", config.jwksUri, errors);
  const resourceUrl = requireHttpsUrl("LETTER_IRL_MCP_RESOURCE", config.resource, errors);

  if (issuerUrl && !config.issuer.endsWith("/")) {
    errors.push("LETTER_IRL_OAUTH_ISSUER must end with /");
  }
  if (issuerUrl) {
    for (const [name, endpoint] of [
      ["LETTER_IRL_OAUTH_AUTH_ENDPOINT", authUrl],
      ["LETTER_IRL_OAUTH_TOKEN_ENDPOINT", tokenUrl],
      ["LETTER_IRL_OAUTH_JWKS_URI", jwksUrl]
    ] as const) {
      if (endpoint && endpoint.origin !== issuerUrl.origin) {
        errors.push(`${name} must use the configured issuer origin`);
      }
    }
  }
  if (resourceUrl && !resourceUrl.pathname.endsWith("/mcp")) {
    errors.push("LETTER_IRL_MCP_RESOURCE must be the exact canonical /mcp endpoint");
  }
  if (config.audience.length === 0) {
    errors.push("LETTER_IRL_OAUTH_AUDIENCE is required");
  } else if (!config.audience.includes(config.resource)) {
    errors.push("LETTER_IRL_OAUTH_AUDIENCE must include the exact MCP resource");
  }
  // Both modes. The static-DCR flag used to allow a second audience because the
  // legacy merge added one; with the merge gone, a second audience could only be
  // a mistake in LETTER_IRL_OAUTH_AUDIENCE.
  if (config.audience.length !== 1) {
    errors.push("LETTER_IRL_OAUTH_AUDIENCE must name exactly one audience, the MCP resource");
  }
  if (config.algorithms.length !== 1 || config.algorithms[0] !== "RS256") {
    errors.push("LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS must be exactly RS256");
  }
  // Every scope a tool asks the customer to grant must be advertised here
  // too. These are two separate channels - the per-tool securitySchemes carry
  // the request, this list is what the metadata documents - and
  // LETTER_IRL_OAUTH_SCOPES can override the default. Without this a
  // deployment can request openid and offline_access per tool while
  // advertising neither, which is the same advertised-versus-requested drift
  // that caused #160 and #424, just pointing the other way. It bites hardest
  // in static-DCR mode, where our metadata IS the document ChatGPT reads.
  for (const scope of [...PRODUCT_SCOPES, ...SESSION_SCOPES, ...IDENTITY_SCOPES]) {
    if (!config.scopes.includes(scope)) {
      errors.push(`LETTER_IRL_OAUTH_SCOPES must include ${scope}`);
    }
  }
  if (config.staticDcrCompatibility && !config.staticClientId) {
    errors.push("CHATGPT_STATIC_CLIENT_ID is required when static DCR compatibility is enabled");
  }
  if (config.staticDcrCompatibility && config.staticRedirectUris.length === 0) {
    errors.push(
      "CHATGPT_STATIC_REDIRECT_URIS is required when static DCR compatibility is enabled"
    );
  }

  const deploymentEnvironment = env.LETTER_IRL_DEPLOYMENT_ENVIRONMENT;
  const expectedIssuer =
    deploymentEnvironment === "development"
      ? env.LETTER_IRL_OAUTH_DEV_ISSUER
      : deploymentEnvironment === "production"
        ? env.LETTER_IRL_OAUTH_PROD_ISSUER
        : undefined;
  if (
    (deploymentEnvironment === "development" || deploymentEnvironment === "production") &&
    !expectedIssuer
  ) {
    errors.push(
      `LETTER_IRL_OAUTH_${deploymentEnvironment === "development" ? "DEV" : "PROD"}_ISSUER is required for environment isolation`
    );
  } else if (expectedIssuer && config.issuer !== expectedIssuer) {
    errors.push(`OAuth issuer does not match the ${deploymentEnvironment} issuer allowlist`);
  }
  if (
    deploymentEnvironment === "production" &&
    resourceUrl?.hostname.endsWith(".up.railway.app")
  ) {
    errors.push("Production MCP resource must not use a Railway development hostname");
  }

  return errors;
}

export function isCimdEnforcementEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.LETTER_IRL_OAUTH_CIMD_ENFORCEMENT === "true";
}

export function assertValidOAuthConfig(
  config = getOAuthConfig(),
  env: NodeJS.ProcessEnv = process.env
): OAuthConfig {
  const errors = validateOAuthConfig(config, env);
  if (errors.length > 0) {
    throw new Error(`Invalid OAuth configuration:\n- ${errors.join("\n- ")}`);
  }
  return config;
}

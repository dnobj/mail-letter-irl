export const PRODUCT_SCOPES = ["mail:read", "mail:draft", "mail:send"] as const;
export const IDENTITY_SCOPES = ["openid", "profile", "email"] as const;
export const DEFAULT_OAUTH_SCOPES = [...IDENTITY_SCOPES, ...PRODUCT_SCOPES];

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
  const audience = parseList(env.LETTER_IRL_OAUTH_AUDIENCE);

  if (staticDcrCompatibility) {
    audience.push(...parseList(env.LETTER_IRL_OAUTH_LEGACY_AUDIENCES));
  }

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
  if (!config.staticDcrCompatibility && config.audience.length !== 1) {
    errors.push("CIMD mode requires exactly one MCP audience");
  }
  if (config.algorithms.length !== 1 || config.algorithms[0] !== "RS256") {
    errors.push("LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS must be exactly RS256");
  }
  for (const scope of PRODUCT_SCOPES) {
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

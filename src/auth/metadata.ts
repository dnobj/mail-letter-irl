const issuer = process.env.LETTER_IRL_OAUTH_ISSUER ?? "";
const authorizationEndpoint = process.env.LETTER_IRL_OAUTH_AUTH_ENDPOINT ?? "";
const tokenEndpoint = process.env.LETTER_IRL_OAUTH_TOKEN_ENDPOINT ?? "";
const jwksUri = process.env.LETTER_IRL_OAUTH_JWKS_URI ?? "";
const registrationEndpoint = process.env.LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT ?? "";
const scopes = (process.env.LETTER_IRL_OAUTH_SCOPES ?? "openid email profile")
  .split(/[,\s]+/)
  .filter(Boolean);

export function getOpenIdConfiguration(baseUrl: string) {
  return {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    registration_endpoint: `${baseUrl}/oauth/register`, // Our static DCR endpoint (Issue #20)
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    scopes_supported: scopes,
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    redirect_uris_supported: [
      "https://chat.openai.com/aip/auth/callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://platform.openai.com/apps-manage/oauth", // OpenAI app review flow
      "http://localhost:18883/oauth/callback" // Claude Desktop mcp-remote
    ],
    claims_supported: ["aud", "exp", "iat", "iss", "sub", "email", "email_verified"],
    service_documentation: `${baseUrl}/manifest.json`
  };
}

export function getProtectedResourceMetadata(baseUrl: string) {
  return {
    resource: baseUrl,
    authorization_servers: [issuer],
    scopes_supported: scopes,
    jwks_uri: jwksUri,
  };
}

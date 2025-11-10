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
    registration_endpoint: registrationEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: scopes,
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    redirect_uris_supported: ["https://chat.openai.com/aip/auth/callback"],
    claims_supported: ["aud", "exp", "iat", "iss", "sub", "email", "email_verified"],
    service_documentation: `${baseUrl}/manifest.json`
  };
}

export function getProtectedResourceMetadata(baseUrl: string) {
  return {
    issuer,
    jwks_uri: jwksUri,
    resource_documentation: `${baseUrl}/manifest.json`
  };
}

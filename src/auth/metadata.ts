import { getOAuthConfig } from "./oauthConfig.js";

export function getOpenIdConfiguration(baseUrl: string) {
  const config = getOAuthConfig();
  return {
    issuer: config.staticDcrCompatibility ? baseUrl : config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    jwks_uri: config.jwksUri,
    ...(config.staticDcrCompatibility
      ? { registration_endpoint: `${baseUrl}/oauth/register` }
      : {}),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: config.scopes,
    token_endpoint_auth_methods_supported: ["none"],
    claims_supported: ["aud", "exp", "iat", "iss", "sub", "email", "email_verified"],
    service_documentation: `${baseUrl}/manifest.json`
  };
}

export function getProtectedResourceMetadata(baseUrl?: string) {
  const config = getOAuthConfig();
  return {
    resource: config.resource,
    authorization_servers: [
      config.staticDcrCompatibility && baseUrl ? baseUrl : config.issuer
    ],
    scopes_supported: config.scopes
  };
}

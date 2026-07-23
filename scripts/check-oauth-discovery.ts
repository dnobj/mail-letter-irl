const baseUrl = process.env.LETTER_IRL_PUBLIC_BASE_URL?.replace(/\/+$/, "");
const expectedResource = process.env.LETTER_IRL_MCP_RESOURCE;
const expectedIssuer = process.env.LETTER_IRL_OAUTH_ISSUER;

if (!baseUrl || !expectedResource || !expectedIssuer) {
  throw new Error(
    "Set LETTER_IRL_PUBLIC_BASE_URL, LETTER_IRL_MCP_RESOURCE, and LETTER_IRL_OAUTH_ISSUER"
  );
}

async function readJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

const protectedResource = await readJson(
  `${baseUrl}/.well-known/oauth-protected-resource`
);
const authorizationServer = await readJson(
  new URL(".well-known/openid-configuration", expectedIssuer).toString()
);

const failures: string[] = [];
if (protectedResource.resource !== expectedResource) {
  failures.push("protected resource does not match LETTER_IRL_MCP_RESOURCE");
}
if (
  !Array.isArray(protectedResource.authorization_servers) ||
  !protectedResource.authorization_servers.includes(expectedIssuer)
) {
  failures.push("protected resource does not name the expected Auth0 issuer");
}
for (const scope of ["mail:read", "mail:draft", "mail:send"]) {
  if (
    !Array.isArray(protectedResource.scopes_supported) ||
    !protectedResource.scopes_supported.includes(scope)
  ) {
    failures.push(`protected resource does not advertise ${scope}`);
  }
}
if (authorizationServer.issuer !== expectedIssuer) {
  failures.push("Auth0 discovery issuer mismatch");
}
if (authorizationServer.client_id_metadata_document_supported !== true) {
  failures.push("Auth0 discovery does not advertise CIMD support");
}
if (
  !Array.isArray(authorizationServer.code_challenge_methods_supported) ||
  !authorizationServer.code_challenge_methods_supported.includes("S256")
) {
  failures.push("Auth0 discovery does not advertise PKCE S256");
}

if (failures.length > 0) {
  throw new Error(`OAuth discovery contract failed:\n- ${failures.join("\n- ")}`);
}

console.log("OAuth discovery contract passed");

import { getOAuthConfig } from "./oauthConfig.js";

const PROTECTED_RESOURCE_ROUTE =
  process.env.LETTER_IRL_PROTECTED_RESOURCE_ROUTE ??
  "/.well-known/oauth-protected-resource";

function publicBaseUrl(): string {
  return (process.env.LETTER_IRL_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
}

export class InsufficientScopeError extends Error {
  readonly missingScopes: string[];

  constructor(missingScopes: readonly string[]) {
    super(`insufficient_scope: missing ${missingScopes.join(" ")}`);
    this.name = "InsufficientScopeError";
    this.missingScopes = [...missingScopes];
  }
}

export function buildWwwAuthenticateChallenge(
  message: string,
  baseUrl = publicBaseUrl(),
  requiredScopes: readonly string[] = getOAuthConfig().scopes
): string {
  const scopes = requiredScopes.join(" ");

  return [
    `Bearer realm="Letter IRL"`,
    `resource_metadata="${baseUrl}${PROTECTED_RESOURCE_ROUTE}"`,
    scopes ? `scope="${scopes}"` : undefined,
    `error="${message.startsWith("insufficient_scope") ? "insufficient_scope" : "invalid_token"}"`,
    `error_description="${message.replace(/"/g, "'")}"`
  ]
    .filter(Boolean)
    .join(", ");
}

export function buildInsufficientScopeToolResult(
  error: InsufficientScopeError,
  baseUrl = publicBaseUrl()
) {
  const challenge = buildWwwAuthenticateChallenge(
    error.message,
    baseUrl,
    error.missingScopes
  );
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "Additional authorization is required for this action."
      }
    ],
    _meta: {
      "mcp/www_authenticate": [challenge]
    }
  };
}

import { getOAuthConfig } from "./oauthConfig.js";
import type { AuthenticatedUser } from "./tokenValidator.js";

/**
 * Which app is calling, as a profile (#473).
 *
 * Every app gets the same tools. What differs is what the server can trust
 * about how an app reaches the person, and a profile answers that in three
 * flags:
 *
 * - `rendersCards`: our cards (the letter preview, the checkout) show in this
 *   app today.
 * - `honorsCardOnlyTools`: the app keeps a tool marked card-only
 *   (`_meta.ui.visibility: ["app"]`, ChatGPT's `openai/visibility: "private"`)
 *   away from the model, so a call to one can only come from the person
 *   pressing a button on our card. The send rule (#470) trusts a send only
 *   from such an app.
 * - `inAppPurchases`: the app may offer a checkout. Claude does not allow
 *   purchases through connectors (#475).
 *
 * Only ChatGPT is trusted with all three, because only ChatGPT has been
 * tested with our cards. Every other profile starts at "trust nothing" and a
 * flag is turned on for an app only after a live test proves it, so a wrong
 * guess costs a detour through the confirmation link rather than a letter
 * nobody saw.
 */
export type ClientProfileName =
  | "chatgpt"
  | "codex"
  | "claude"
  | "claude_code"
  | "vscode"
  | "hermes"
  | "token"
  | "generic";

export interface ClientProfile {
  readonly name: ClientProfileName;
  readonly rendersCards: boolean;
  readonly honorsCardOnlyTools: boolean;
  readonly inAppPurchases: boolean;
}

const TRUSTS_NOTHING = {
  rendersCards: false,
  honorsCardOnlyTools: false,
  inAppPurchases: false
} as const;

const PROFILES: Readonly<Record<ClientProfileName, ClientProfile>> = {
  chatgpt: {
    name: "chatgpt",
    rendersCards: true,
    honorsCardOnlyTools: true,
    inAppPurchases: true
  },
  // Claude renders MCP Apps cards, but not ours until they speak the MCP Apps
  // bridge (#474), and it refuses purchases through connectors (#475).
  claude: { name: "claude", ...TRUSTS_NOTHING },
  claude_code: { name: "claude_code", ...TRUSTS_NOTHING },
  codex: { name: "codex", ...TRUSTS_NOTHING },
  vscode: { name: "vscode", ...TRUSTS_NOTHING },
  hermes: { name: "hermes", ...TRUSTS_NOTHING },
  // A personal access token is whatever the person pointed it at: an agent,
  // a script, a client with no card. Nothing about it can be trusted to have
  // shown them anything.
  token: { name: "token", ...TRUSTS_NOTHING },
  generic: { name: "generic", ...TRUSTS_NOTHING }
};

/**
 * Auth0 puts a client ID metadata document's URL in the access token as the
 * client id, so an app registered from its own document is recognised by that
 * URL on both tenants. Only documents imported into our tenant can mint a
 * token at all, which is what makes a URL match trustworthy.
 */
const CLIENT_DOCUMENTS: ReadonlyMap<string, ClientProfileName> = new Map([
  ["https://claude.ai/oauth/mcp-oauth-client-metadata", "claude"],
  ["https://claude.ai/oauth/claude-code-client-metadata", "claude_code"],
  ["https://vscode.dev/oauth/client-metadata.json", "vscode"],
  [
    "https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json",
    "hermes"
  ],
  // ChatGPT's and Codex's stable documents. They need an authorization server
  // that returns `iss` (RFC 9207), which Auth0 does not, so today both use a
  // document per callback id instead (the patterns below). Listed so that
  // changing Auth0 cannot turn ChatGPT into a stranger.
  ["https://chatgpt.com/oauth/client.json", "chatgpt"],
  ["https://chatgpt.com/oauth/codex/client.json", "codex"]
]);

// Checked after the exact list and in this order: the stable Codex document,
// https://chatgpt.com/oauth/codex/client.json, also fits the ChatGPT pattern.
const CODEX_CALLBACK_DOCUMENT =
  /^https:\/\/chatgpt\.com\/oauth\/codex\/[A-Za-z0-9_-]+\/client\.json$/;
const CHATGPT_CALLBACK_DOCUMENT =
  /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]+\/client\.json$/;

/**
 * The client id an access token was issued to. Auth0 writes `azp`; a token in
 * the RFC 9068 profile writes `client_id`. Either is the application Auth0
 * issued the token to, never anything the caller chose.
 */
export function clientIdOf(user: AuthenticatedUser | null): string | undefined {
  if (!user || user.authType !== "jwt") {
    return undefined;
  }
  for (const claim of ["client_id", "azp"] as const) {
    const value = user.claims[claim];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function profileNameForClientId(clientId: string): ClientProfileName {
  const documented = CLIENT_DOCUMENTS.get(clientId);
  if (documented) {
    return documented;
  }
  if (CODEX_CALLBACK_DOCUMENT.test(clientId)) {
    return "codex";
  }
  if (CHATGPT_CALLBACK_DOCUMENT.test(clientId)) {
    return "chatgpt";
  }
  // The rollback path (static registration, #20) hands ChatGPT a client id
  // Auth0 made up rather than a document URL.
  const staticClientId = getOAuthConfig().staticClientId?.trim();
  if (staticClientId && clientId === staticClientId) {
    return "chatgpt";
  }
  return "generic";
}

export function resolveClientProfile(user: AuthenticatedUser | null): ClientProfile {
  if (user?.authType === "pat") {
    return PROFILES.token;
  }
  const clientId = clientIdOf(user);
  return PROFILES[clientId ? profileNameForClientId(clientId) : "generic"];
}

/**
 * For the request log, which takes fixed-vocabulary fields only (CIMD-08): the
 * profile name, and for an app we do not recognise, the shape of its client
 * id - a document URL means a new app registered from its own document, an
 * opaque id means one registered by hand. The id itself is never logged; the
 * Auth0 application list names every app that can obtain a token.
 */
export function clientLogFields(
  user: AuthenticatedUser | null
): { client: ClientProfileName; clientIdKind?: "url" | "opaque" | "absent" } {
  const profile = resolveClientProfile(user);
  if (profile.name !== "generic") {
    return { client: profile.name };
  }
  const clientId = clientIdOf(user);
  return {
    client: profile.name,
    clientIdKind: !clientId ? "absent" : /^https:\/\//.test(clientId) ? "url" : "opaque"
  };
}

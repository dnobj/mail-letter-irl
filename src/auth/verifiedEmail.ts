import type { AuthenticatedUser } from "./tokenValidator.js";

/**
 * What an account may be opened from: a confirmed email address.
 *
 * Letter IRL keys accounts on the Auth0 subject, and Auth0 mints a separate
 * subject per sign-in method. `users.email` is NOT NULL UNIQUE
 * (db/migrations/001_initial_schema.sql:7), so one person arriving by a second
 * method collides on that key, and four call sites used to paper over a
 * missing address by writing `<subject>@unknown.com`. Those ghost rows are
 * invisible to every per-email rule we have - including the gift "you cannot
 * redeem your own code" check, which a ghost account walked straight through
 * on 2026-09-18.
 *
 * The address is also what an Auth0 post-login Action links identities on, and
 * linking an address nobody proved they own is account takeover. So the rule
 * is one rule in both places: no confirmed address, no account.
 *
 * Nothing here touches the database or reads the environment at module load;
 * both are resolved per call, the way src/auth/betaAccess.ts does it.
 */

/**
 * What a refused caller is told, everywhere. One constant because it reaches
 * the MCP tool layer and the REST surface, and fixed text with nothing
 * interpolated is what makes it safe to put in an HTTP body.
 * support@letterirl.com is the address already published in manifest.json.
 */
export const VERIFIED_EMAIL_MESSAGE =
  "Letter IRL needs a confirmed email address to open your account. " +
  "Confirm the address on the account you signed in with, then try again. " +
  "If you have already confirmed it, email support@letterirl.com.";

/**
 * Refusal for want of a confirmed address, distinct from any authentication
 * failure - the same distinction, and for the same reason, as
 * BetaAccessDeniedError: a 401 with a challenge would send the caller back
 * through Auth0, where they would authenticate perfectly well and be refused
 * again. 403, no challenge, do not retry until the address is confirmed.
 */
export class VerifiedEmailRequiredError extends Error {
  readonly statusCode = 403;

  constructor() {
    super(VERIFIED_EMAIL_MESSAGE);
    this.name = "VerifiedEmailRequiredError";
  }
}

/**
 * Where an Auth0 Action can put the email on the ACCESS token.
 *
 * It has to be namespaced. Auth0 silently drops a non-namespaced custom claim
 * that collides with a reserved OIDC name, and `email` is reserved: the login
 * succeeds, the claim is absent, and nothing anywhere reports it. An Action
 * calling setCustomClaim("email", ...) is a no-op that looks like a fix - we
 * deployed exactly that against production and the next tool call failed the
 * same foreign key it had failed before.
 *
 * Configurable because the namespace is a deployment's own domain, and the two
 * environments do not share one.
 *
 * @see https://auth0.com/docs/troubleshoot/product-lifecycle/deprecations-and-migrations/custom-claims-migration
 */
export const DEFAULT_EMAIL_CLAIM = "https://letterirl.com/email";

/**
 * Where the same Action states whether that address is confirmed.
 *
 * **Silence is trusted; a negative refuses.** An issuer that says
 * `email_verified: false` is refused, and an address that arrives with no
 * verdict beside it is taken as confirmed. That asymmetry is deliberate and it
 * is the same rule for all three sources below.
 *
 * Two reasons. The Action's contract, written out in
 * docs/auth0-tenant-configuration.md, is that it sets the address claim ONLY
 * for a confirmed address, so silence from it means "vouched for", not
 * "unknown". And the gate that actually stops an unconfirmed address from
 * reaching an account is in Auth0 itself - the post-login Action refuses the
 * login and refuses to link the identity - which is the only place that can
 * stop it before a subject exists. Refusing here on silence would add nothing
 * to that and would take every session down the moment a claim shape changed,
 * on a tenant we configure by hand and cannot roll back with a deploy.
 */
export const DEFAULT_EMAIL_VERIFIED_CLAIM = "https://letterirl.com/email_verified";

export interface EmailClaim {
  address: string;
  /** Whether the issuer says the address has been confirmed. */
  verified: boolean;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Auth0 writes `email_verified` as a boolean, but a custom claim set from a
 * string, and a userinfo document proxied through something helpful, can both
 * arrive as "true". Anything else - absent, null, "1", 1 - is not a yes.
 */
function readVerifiedFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * The address this token carries, and whether it is confirmed.
 *
 * Order matters. The standard `email` claim comes first: if Auth0 ever does
 * put one on an access token minted for a custom API, that is the one to
 * believe and no Action is needed at all. The namespaced claim is ours. Both
 * are read under the rule above - an explicit `email_verified: false` refuses,
 * anything else is confirmed.
 */
export function readEmailClaim(
  claims: AuthenticatedUser["claims"],
  env: NodeJS.ProcessEnv = process.env
): EmailClaim | null {
  const bag = claims as Record<string, unknown>;

  const standard = readString(bag.email);
  if (standard) {
    return { address: standard, verified: readVerifiedFlag(bag.email_verified) !== false };
  }

  const namespaced = readString(bag[env.LETTER_IRL_OAUTH_EMAIL_CLAIM ?? DEFAULT_EMAIL_CLAIM]);
  if (!namespaced) return null;

  const stated = readVerifiedFlag(
    bag[env.LETTER_IRL_OAUTH_EMAIL_VERIFIED_CLAIM ?? DEFAULT_EMAIL_VERIFIED_CLAIM]
  );
  return { address: namespaced, verified: stated ?? true };
}

/** The same reading of a `/userinfo` document, where both fields are standard. */
export function readUserInfoEmail(document: unknown): EmailClaim | null {
  if (typeof document !== "object" || document === null) return null;
  const bag = document as Record<string, unknown>;
  const address = readString(bag.email);
  if (!address) return null;
  return { address, verified: readVerifiedFlag(bag.email_verified) !== false };
}

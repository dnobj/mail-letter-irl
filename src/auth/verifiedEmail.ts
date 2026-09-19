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
 * **Silence is not confirmation, and it is not a refusal either.** The verdict
 * has three values, and the third one is the useful one:
 *
 *   - `true`  - the issuer says the address is confirmed. An account opens.
 *   - `false` - the issuer says it is not. Refused, with no further questions.
 *   - `null`  - the issuer did not say. Nothing is assumed; identity.ts asks
 *               `/userinfo`, which is the same issuer, answering directly.
 *
 * An earlier draft trusted silence, on the argument that the Action only ever
 * sets the address claim for a confirmed address. That was wrong: the Action
 * deployed on both tenants until 2026-09-19 set the claim for ANY address,
 * confirmed or not, so silence from it meant nothing - and trusting it would
 * let an unconfirmed sign-up take the account slot of the address's real
 * owner, which is the one thing this whole change exists to prevent.
 *
 * The draft after that collapsed `null` into `false`, and refused every new
 * customer on a tenant whose Action had not been updated yet - including the
 * ones whose address was confirmed - telling them to confirm an address they
 * had already confirmed. Tokens live 24 hours, so that outlives the Action
 * update itself.
 *
 * Three values, because the two questions are different: "did the issuer
 * vouch for this?" and "will it, if asked?".
 */
export const DEFAULT_EMAIL_VERIFIED_CLAIM = "https://letterirl.com/email_verified";

export interface EmailClaim {
  address: string;
  /** true confirmed, false refused, null the issuer did not say. */
  verdict: boolean | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Auth0 writes `email_verified` as a boolean, but a custom claim set from a
 * string, and a userinfo document proxied through something helpful, can both
 * arrive as "true". Anything else - absent, null, "1", 1, "yes" - is not a
 * verdict at all, and becomes null rather than a refusal.
 */
function readVerdict(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * The address this token carries, and the issuer's verdict on it.
 *
 * Order matters. The standard `email` claim comes first: if Auth0 ever does
 * put one on an access token minted for a custom API, that is the one to
 * believe and no Action is needed at all. The namespaced claim is ours. Each
 * carries its own verdict, read under the three-valued rule above.
 */
export function readEmailClaim(
  claims: AuthenticatedUser["claims"],
  env: NodeJS.ProcessEnv = process.env
): EmailClaim | null {
  const bag = claims as Record<string, unknown>;

  const standard = readString(bag.email);
  if (standard) {
    return { address: standard, verdict: readVerdict(bag.email_verified) };
  }

  const namespaced = readString(bag[env.LETTER_IRL_OAUTH_EMAIL_CLAIM ?? DEFAULT_EMAIL_CLAIM]);
  if (!namespaced) return null;

  return {
    address: namespaced,
    verdict: readVerdict(
      bag[env.LETTER_IRL_OAUTH_EMAIL_VERIFIED_CLAIM ?? DEFAULT_EMAIL_VERIFIED_CLAIM]
    )
  };
}

/** The same reading of a `/userinfo` document, where both fields are standard. */
export function readUserInfoEmail(document: unknown): EmailClaim | null {
  if (typeof document !== "object" || document === null) return null;
  const bag = document as Record<string, unknown>;
  const address = readString(bag.email);
  if (!address) return null;
  // Asked directly, and answering nothing is its own answer: this is the
  // issuer speaking, not a claim shape that might predate an Action update.
  return { address, verdict: readVerdict(bag.email_verified) };
}

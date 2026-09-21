import { EmailAlreadyLinkedError, findUser, getOrCreateUser } from "../services/userService.js";
import { AuthenticatedUser } from "./tokenValidator.js";
import { writeDiagnostic } from "../utils/diagnosticLog.js";
import { VerifiedEmailRequiredError, readEmailClaim } from "./verifiedEmail.js";

interface IdentityDependencies {
  findExistingUser: typeof findUser;
  upsertUser: typeof getOrCreateUser;
}

const defaultDependencies: IdentityDependencies = {
  findExistingUser: findUser,
  upsertUser: getOrCreateUser
};

export { DEFAULT_EMAIL_CLAIM } from "./verifiedEmail.js";

/*
 * Auth0's `/userinfo` used to be consulted here when a token carried an
 * address but no verdict, as a way through the window between an API deploy
 * and a tenant's Action being updated. It is gone, after three review rounds
 * in a row found something wrong with it, and the last of them found the
 * thing that settles it: `/userinfo` needs `openid` on the access token, and
 * ChatGPT - the client this product is for - did not ask for one. So it served
 * website first-arrivals only, in a window the mandated order (Action first,
 * then deploy) is supposed to be empty, while quietly letting the WEBSITE
 * tolerate a missing or broken claim Action. That is the surface LINK-01 uses
 * to check a tenant, and a silently no-op Action is exactly what took the
 * first production account down.
 *
 * ChatGPT DOES request `openid` now (#424 - it needs an ID token to record
 * which account connected), so the scope half of that reasoning has expired.
 * The fallback does not come back on the strength of that: what settled it was
 * never the scope, it was that a fallback which WORKS lets a broken claim
 * Action ship unnoticed on the very surface used to verify a tenant.
 *
 * So the claim Action is now load-bearing on every surface, and its absence
 * fails the same way everywhere: one sentence, and a diagnostic that says
 * which state it is.
 */

/**
 * Make sure this caller has an account row, or refuse.
 *
 * Returns the confirmed address when there is one, so a caller that needs it -
 * the REST middleware, which used to read the standard claim only and hand
 * every route `email: undefined` - does not resolve it a second time.
 *
 * **An account that already exists is never refused.** A personal access token
 * carries no claims at all and lands here on every call; so does an OAuth
 * token minted before a tenant's Action was updated; and an address that
 * another subject already holds means the linking Action has not joined them
 * yet. None of those is a reason to lock someone out of an account that
 * works, and
 * the stored address - which WAS confirmed when it was written - is left
 * exactly as it is.
 *
 * @throws VerifiedEmailRequiredError when no account exists and none can be
 * opened, because the token carries no confirmed address.
 * @throws EmailAlreadyLinkedError when no account exists and the address
 * belongs to another subject.
 */
export async function prepareAuthenticatedUser(
  authInfo: AuthenticatedUser,
  dependencies: IdentityDependencies = defaultDependencies,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const claim = readEmailClaim(authInfo.claims, env);

  if (claim?.verdict === true) {
    try {
      // The stored address is this one once the upsert returns: getOrCreateUser
      // creates with it or updates to it.
      await dependencies.upsertUser(authInfo.userId, claim.address);
      return claim.address;
    } catch (error) {
      if (!(error instanceof EmailAlreadyLinkedError)) throw error;
      // The address is held by another subject. If this one has an account,
      // it keeps it and its own address: refusing here would lock someone out
      // of a working account for a conflict they cannot see, with a message
      // telling them to do the thing they just did.
      const existingUser = await dependencies.findExistingUser(authInfo.userId);
      if (!existingUser) throw error;
      writeDiagnostic("warn", "auth.email_conflict_not_stored", {
        authType: authInfo.authType
      });
      return existingUser.email;
    }
  }

  const existingUser = await dependencies.findExistingUser(authInfo.userId);
  if (existingUser) {
    if (claim?.verdict === false) {
      writeDiagnostic("warn", "auth.email_unconfirmed_not_stored", {
        authType: authInfo.authType
      });
    }
    return existingUser.email;
  }

  // NOT a deferral. Nothing retries this, and `users.email` is NOT NULL, so
  // there is no row to create without a confirmed address - the account simply
  // does not exist and every write the customer attempts would fail somewhere
  // else, wearing the name of whatever table it lands on first.
  //
  // That is what happened to the first production account: the balance read
  // 0 (a SELECT finding no row), the return-address save claimed success (an
  // UPDATE matching no row), and the draft failed on
  // letter_drafts.user_id -> users(user_id) as a "database error". Three
  // symptoms, three subsystems, one absent row - and the log line that would
  // have said so was both mis-levelled and, being fieldless JSON, invisible.
  //
  // So it throws now. One refusal, in a sentence the customer can act on,
  // instead of three failures that name the wrong thing. The diagnostic keeps
  // its name and its level: it is the same state, now reported rather than
  // merely survived.
  // Three reasons, because they need three different answers: an Action that
  // sets the verdict to false; an Action that sets the address and not the
  // verdict; and no Action reaching this token at all. On a tenant configured
  // as docs/auth0-tenant-configuration.md describes, all three are the
  // tenant's fault - a customer who has not confirmed their address is denied
  // by the linking Action before a token exists, and the claim Action sets
  // nothing for one rather than setting false.
  writeDiagnostic("error", "auth.account_missing_no_verified_email", {
    reason:
      claim?.verdict === false
        ? "email_unconfirmed"
        : claim
          ? "email_verdict_unavailable"
          : "verified_email_unavailable",
    consequence: "account_not_opened",
    authType: authInfo.authType
  });
  throw new VerifiedEmailRequiredError();
}

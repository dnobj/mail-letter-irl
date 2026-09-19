import { EmailAlreadyLinkedError, findUser, getOrCreateUser } from "../services/userService.js";
import { AuthenticatedUser } from "./tokenValidator.js";
import { writeDiagnostic } from "../utils/diagnosticLog.js";
import {
  EmailClaim,
  VerifiedEmailRequiredError,
  readEmailClaim,
  readUserInfoEmail
} from "./verifiedEmail.js";

interface IdentityDependencies {
  fetchUserInfo: typeof fetch;
  findExistingUser: typeof findUser;
  upsertUser: typeof getOrCreateUser;
}

const defaultDependencies: IdentityDependencies = {
  fetchUserInfo: fetch,
  findExistingUser: findUser,
  upsertUser: getOrCreateUser
};

export { DEFAULT_EMAIL_CLAIM } from "./verifiedEmail.js";

/**
 * What `/userinfo` says, when the token itself says nothing.
 *
 * Consulted only for a caller with no account yet, and only when the token
 * gave no verdict: it is a network call on the authentication path, Auth0
 * rate-limits it per user (burst 10, 5/minute sustained), and a REST page load
 * makes several requests. An existing account needs nothing from it, and an
 * issuer that already said "not confirmed" has nothing left to add.
 *
 * What it is for: a token minted before a tenant's Action was updated carries
 * an address with no verdict beside it. Asking here is what lets a customer
 * whose address IS confirmed open an account during that window, instead of
 * being told to confirm an address they confirmed long ago - for the 24 hours
 * their token lives.
 */
async function askUserInfo(
  authInfo: AuthenticatedUser,
  dependencies: IdentityDependencies,
  env: NodeJS.ProcessEnv
): Promise<EmailClaim | null> {
  const issuer = env.LETTER_IRL_OAUTH_ISSUER;
  if (!issuer || authInfo.authType !== "jwt") return null;

  try {
    const response = await dependencies.fetchUserInfo(new URL("userinfo", issuer), {
      headers: { Authorization: `Bearer ${authInfo.token}` },
      // Authentication is in front of every request; an issuer that hangs must
      // not hang them all.
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      writeDiagnostic("warn", "auth.userinfo_failed", { status: response.status });
      return null;
    }
    return readUserInfoEmail(await response.json());
  } catch {
    writeDiagnostic("warn", "auth.userinfo_failed", { errorClass: "request_failed" });
    return null;
  }
}

/**
 * Make sure this caller has an account row, or refuse.
 *
 * Returns the confirmed address when there is one, so a caller that needs it -
 * the REST middleware, which used to read the standard claim only and hand
 * every route `email: undefined` - does not resolve it a second time.
 *
 * **An account that already exists is never refused.** A personal access token
 * carries no claims at all and lands here on every call; so does an OAuth
 * token while a tenant's Action is being updated; and an address that another
 * subject already holds means the linking Action has not joined them yet.
 * None of those is a reason to lock someone out of an account that works, and
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
  let claim = readEmailClaim(authInfo.claims, env);

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

  // No account, and no verdict to go on. One network call, to the issuer that
  // would have set the claim: this is the whole of the rollout window, where
  // the token predates the Action that states the verdict.
  if (!claim || claim.verdict === null) {
    claim = (await askUserInfo(authInfo, dependencies, env)) ?? claim;
    if (claim?.verdict === true) {
      await dependencies.upsertUser(authInfo.userId, claim.address);
      return claim.address;
    }
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

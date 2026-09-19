import { findUser, getOrCreateUser } from "../services/userService.js";
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
 * The address this caller's token carries, from the claim or from `/userinfo`.
 *
 * `/userinfo` is consulted when the token itself says nothing, which is the
 * normal shape of an access token minted for a custom API, and it is the only
 * place a tenant whose Action has not been updated can still state whether the
 * address is confirmed.
 */
async function resolveEmail(
  authInfo: AuthenticatedUser,
  dependencies: IdentityDependencies,
  env: NodeJS.ProcessEnv
): Promise<EmailClaim | null> {
  const fromClaims = readEmailClaim(authInfo.claims, env);
  if (fromClaims || authInfo.authType !== "jwt") return fromClaims;

  const issuer = env.LETTER_IRL_OAUTH_ISSUER;
  if (!issuer) return null;

  try {
    const response = await dependencies.fetchUserInfo(new URL("userinfo", issuer), {
      headers: { Authorization: `Bearer ${authInfo.token}` }
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
 * @throws VerifiedEmailRequiredError when no account exists and none can be
 * opened, because the token carries no confirmed address.
 */
export async function prepareAuthenticatedUser(
  authInfo: AuthenticatedUser,
  dependencies: IdentityDependencies = defaultDependencies,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const claim = await resolveEmail(authInfo, dependencies, env);

  if (claim?.verified) {
    await dependencies.upsertUser(authInfo.userId, claim.address);
    return claim.address;
  }

  const existingUser = await dependencies.findExistingUser(authInfo.userId);
  if (existingUser) {
    // The account is already open. A personal access token carries no claims
    // at all and lands here on every call; so does an OAuth token during a
    // tenant's Action update. Neither is a reason to lock someone out of an
    // account that exists - and the stored address, which WAS confirmed when
    // it was written, is left exactly as it is.
    if (claim) {
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
  writeDiagnostic("error", "auth.account_missing_no_verified_email", {
    reason: claim ? "email_unconfirmed" : "verified_email_unavailable",
    consequence: "account_not_opened",
    authType: authInfo.authType
  });
  throw new VerifiedEmailRequiredError();
}

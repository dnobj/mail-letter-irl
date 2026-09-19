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
 * What `/userinfo` says, when the token itself gave no verdict.
 *
 * **It cannot answer for a ChatGPT token.** Auth0 requires `openid` on the
 * access token, and ChatGPT asks for the union of the per-tool
 * securitySchemes, which is the product scopes plus `offline_access`
 * (registerTools.ts, SESSION_SCOPES) - no `openid`, deliberately, since the
 * MCP layer has never needed an identity scope. So this serves the website's
 * tokens and nothing else, and it is asked only when the token carries the
 * scope: a call that can only 401 is not worth making on the authentication
 * path, and Auth0 rate-limits it per user (burst 10, 5/minute).
 *
 * What it is for, then, is narrow: a WEBSITE token minted before a tenant's
 * Action was updated carries an address with no verdict beside it, and those
 * tokens live two hours. A ChatGPT customer arriving for the first time on
 * such a token is refused until they reconnect - which is why the Action goes
 * into a tenant's flow BEFORE the API is deployed against it, and why the
 * refusal says which of the two states it is.
 */
interface UserInfoAnswer {
  claim: EmailClaim | null;
  /** Why there is no claim, for the refusal diagnostic. */
  outcome: string;
}

async function askUserInfo(
  authInfo: AuthenticatedUser,
  dependencies: IdentityDependencies,
  env: NodeJS.ProcessEnv
): Promise<UserInfoAnswer> {
  if (authInfo.authType !== "jwt") return { claim: null, outcome: "not_asked_pat" };
  if (!authInfo.scopes.includes("openid")) {
    return { claim: null, outcome: "not_asked_no_openid" };
  }
  const issuer = env.LETTER_IRL_OAUTH_ISSUER;
  if (!issuer) return { claim: null, outcome: "not_asked_no_issuer" };

  try {
    const response = await dependencies.fetchUserInfo(new URL("userinfo", issuer), {
      headers: { Authorization: `Bearer ${authInfo.token}` },
      // Authentication is in front of every request; an issuer that hangs must
      // not hang them all.
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      writeDiagnostic("warn", "auth.userinfo_failed", { status: response.status });
      return { claim: null, outcome: `http_${response.status}` };
    }
    const claim = readUserInfoEmail(await response.json());
    if (!claim) return { claim: null, outcome: "no_address" };
    return { claim, outcome: claim.verdict === null ? "no_verdict" : "answered" };
  } catch {
    writeDiagnostic("warn", "auth.userinfo_failed", { errorClass: "request_failed" });
    return { claim: null, outcome: "request_failed" };
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

  // No account, and no verdict to go on. Ask the issuer, where the token
  // allows it: a website token minted before its tenant's Action was updated
  // carries an address and no verdict, and this is what opens its account.
  let userInfo = "not_asked";
  if (!claim || claim.verdict === null) {
    const answer = await askUserInfo(authInfo, dependencies, env);
    userInfo = answer.outcome;
    claim = answer.claim ?? claim;
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
  // `userInfo` is on the same line as the reason on purpose. The rollout case
  // - a token minted before the tenant's Action was updated - looks identical
  // to a genuinely unconfirmed address unless you can see whether the issuer
  // was asked and what it said, and the two lines are otherwise tied together
  // only by their timestamps.
  writeDiagnostic("error", "auth.account_missing_no_verified_email", {
    reason:
      claim?.verdict === false
        ? "email_unconfirmed"
        : claim
          ? "email_verdict_unavailable"
          : "verified_email_unavailable",
    userInfo,
    consequence: "account_not_opened",
    authType: authInfo.authType
  });
  throw new VerifiedEmailRequiredError();
}

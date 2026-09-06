import { findUser, getOrCreateUser } from "../services/userService.js";
import { AuthenticatedUser } from "./tokenValidator.js";
import { writeDiagnostic } from "../utils/diagnosticLog.js";

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

/**
 * Where an Auth0 Action can put the verified email on the ACCESS token.
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

function readEmailClaim(
  claims: AuthenticatedUser["claims"],
  env: NodeJS.ProcessEnv
): string | null {
  // The standard claim first: if Auth0 ever does put `email` on the access
  // token, that is the one to believe, and no Action is needed at all.
  if (typeof claims.email === "string" && claims.email.length > 0) {
    return claims.email;
  }

  const namespaced = env.LETTER_IRL_OAUTH_EMAIL_CLAIM ?? DEFAULT_EMAIL_CLAIM;
  const value = (claims as Record<string, unknown>)[namespaced];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function prepareAuthenticatedUser(
  authInfo: AuthenticatedUser,
  dependencies: IdentityDependencies = defaultDependencies,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  let email = readEmailClaim(authInfo.claims, env);

  if (!email && authInfo.authType === "jwt") {
    try {
      const issuer = env.LETTER_IRL_OAUTH_ISSUER;
      if (issuer) {
        const response = await dependencies.fetchUserInfo(new URL("userinfo", issuer), {
          headers: { Authorization: `Bearer ${authInfo.token}` }
        });
        if (response.ok) {
          const userInfo = (await response.json()) as { email?: unknown };
          email = typeof userInfo.email === "string" ? userInfo.email : null;
        } else {
          writeDiagnostic("warn", "auth.userinfo_failed", { status: response.status });
        }
      }
    } catch {
      writeDiagnostic("warn", "auth.userinfo_failed", { errorClass: "request_failed" });
    }
  }

  const existingUser = await dependencies.findExistingUser(authInfo.userId);
  if (email) {
    await dependencies.upsertUser(authInfo.userId, email);
  } else if (!existingUser) {
    // NOT a deferral. Nothing retries this, and `users.email` is NOT NULL, so
    // there is no row to create without an address - the account simply does
    // not exist and every write the customer attempts will fail somewhere
    // else, wearing the name of whatever table it lands on first.
    //
    // That is what happened to the first production account: the balance read
    // 0 (a SELECT finding no row), the return-address save claimed success (an
    // UPDATE matching no row), and the draft failed on
    // letter_drafts.user_id -> users(user_id) as a "database error". Three
    // symptoms, three subsystems, one absent row - and the log line that would
    // have said so was both mis-levelled and, being fieldless JSON, invisible.
    //
    // Raised to error, and named for the state it leaves behind rather than
    // for the step that was skipped.
    writeDiagnostic("error", "auth.account_missing_no_verified_email", {
      reason: "verified_email_unavailable",
      consequence: "account_writes_will_fail",
      authType: authInfo.authType
    });
  }
}

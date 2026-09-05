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

export async function prepareAuthenticatedUser(
  authInfo: AuthenticatedUser,
  dependencies: IdentityDependencies = defaultDependencies
): Promise<void> {
  let email =
    typeof authInfo.claims.email === "string" ? authInfo.claims.email : null;

  if (!email && authInfo.authType === "jwt") {
    try {
      const issuer = process.env.LETTER_IRL_OAUTH_ISSUER;
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

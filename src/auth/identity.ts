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
    writeDiagnostic("warn", "auth.account_creation_deferred", {
      reason: "verified_email_unavailable"
    });
  }
}

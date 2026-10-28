/**
 * The refusal for an account that was erased at the customer's request (#289).
 *
 * The erasure keeps the users row as a tombstone, because the orders, ledger
 * lots and disputes kept for accounting point at it, and marks it erased_at
 * (db/migrations/035_account_erasure.sql). Nothing may use or write to it
 * again. Without this refusal the next sign-in would put the person's address
 * back on the row (getOrCreateUser) and carry on as if nothing had happened:
 * a social sign-in brings back the same subject, and an access token issued
 * before the erasure stays valid for up to a day.
 */

/**
 * Fixed text, like the other account refusals: it reaches the MCP tool layer
 * and the REST surface whole. It points at support rather than at signing up
 * again, because a Google or Apple sign-in brings back the same subject and
 * would be refused again; support can reopen the account by hand
 * (docs/account-erasure.md).
 */
export const ACCOUNT_ERASED_MESSAGE =
  "This Letter IRL account was closed and its data erased at your request, so it " +
  "can no longer be used. To use Letter IRL again, email support@letterirl.com.";

/**
 * 403, for the reason VerifiedEmailRequiredError gives: signing in again
 * produces the same token and the same answer.
 */
export class AccountErasedError extends Error {
  readonly statusCode = 403;
  // Picked up by carriedDiagnosticClass (src/utils/diagnosticLog.ts).
  readonly diagnosticClass = "authorization_error";

  constructor() {
    super(ACCOUNT_ERASED_MESSAGE);
    this.name = "AccountErasedError";
  }
}

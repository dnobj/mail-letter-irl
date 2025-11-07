import { UserAccount } from "../contracts/types.js";

export function ensureSufficientCredits(
  account: UserAccount,
  requiredCredits: number
): void {
  if (account.creditsRemaining < requiredCredits) {
    throw new Error(
      `Insufficient credits. Available: ${account.creditsRemaining}, required: ${requiredCredits}`
    );
  }
}

export function deductCredits(
  account: UserAccount,
  requiredCredits: number
): number {
  account.creditsRemaining = Number(
    (account.creditsRemaining - requiredCredits).toFixed(2)
  );
  return account.creditsRemaining;
}

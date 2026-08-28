import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  getAccountBalanceInputSchema,
  getAccountBalanceOutputSchema
} from "../schemas.js";
import { getBalance, getDetailedBalance } from "../services/creditService.js";
import { findUser } from "../services/userService.js";
import { getGenerationQuota } from "../services/imageGenerationLimitService.js";

interface ExpiringLettersInfo {
  letters: number;
  expiresAt: string;
  daysUntilExpiry: number;
}

interface GetAccountBalanceOutput {
  lettersRemaining: number;
  canSendStandardLetter: boolean;
  message?: string;
  lettersExpiringSoon?: number;
  expiringLettersDetails?: ExpiringLettersInfo[];
  imageGenerationsRemaining?: number;
  imageGenerationsAllowance?: number;
}


async function handler(
  _input: Record<string, never>,
  context: ToolContext
): Promise<GetAccountBalanceOutput> {
  const standardCost = 2; // Updated to 2 credits per letter (matches pricing)

  // Get user ID from context
  const userId = context.user.userId || 'default-user';

  // Fetch user info from database to get email
  const user = await findUser(userId);
  const email = user?.email || 'Unknown';

  // Extract auth provider from userId (format: "google-oauth2|123456")
  const providerPart = userId.split('|')[0] || 'unknown';
  const providerMap: Record<string, string> = {
    'google-oauth2': 'Google',
    'windowslive': 'Microsoft',
    'apple': 'Apple',
    'github': 'GitHub',
    'auth0': 'Email/Password'
  };
  const authProvider = providerMap[providerPart] || providerPart;

  // Internal credit values (2 credits = 1 letter)
  let internalCredits: number;
  let internalCreditsExpiring = 0;
  let expiringLettersDetails: ExpiringLettersInfo[] = [];

  try {
    // Get detailed balance with expiration info
    const detailedBalance = await getDetailedBalance(userId);
    internalCredits = detailedBalance.totalAvailable;
    internalCreditsExpiring = detailedBalance.expiringSoon;

    // Build expiring letters details (only include buckets that expire)
    const now = new Date();
    expiringLettersDetails = detailedBalance.expiringDates
      .filter(bucket => bucket.expiresAt !== null)
      .map(bucket => {
        const expiresAt = bucket.expiresAt as Date;
        const daysUntilExpiry = Math.ceil(
          (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );
        return {
          letters: Math.floor(bucket.credits / standardCost),
          expiresAt: expiresAt.toISOString(),
          daysUntilExpiry
        };
      })
      .filter(info => info.daysUntilExpiry > 0 && info.letters > 0); // Only future expirations with at least 1 letter
  } catch (error) {
    // User doesn't exist yet or no ledger entries
    if (error instanceof Error && error.message.includes('User not found')) {
      internalCredits = 0;
    } else {
      // Try simple balance as fallback
      try {
        const balance = await getBalance(userId);
        internalCredits = balance.credits;
      } catch {
        internalCredits = 0;
      }
    }
  }

  // Convert internal credits to user-facing letters (2 credits = 1 letter)
  const lettersRemaining = Math.floor(internalCredits / standardCost);
  const lettersExpiringSoon = Math.floor(internalCreditsExpiring / standardCost);
  const canSendStandardLetter = lettersRemaining >= 1;

  // Fetch image generation quota
  let imageGenerationsRemaining: number | undefined;
  let imageGenerationsAllowance: number | undefined;
  try {
    const generationQuota = await getGenerationQuota(userId);
    imageGenerationsRemaining = generationQuota.remaining;
    imageGenerationsAllowance = generationQuota.allowance;
  } catch {
    // Ignore — user may not exist yet
  }

  // Enhanced message with identity information
  const identityLine = `Account: ${email} (${authProvider})`;
  let balanceLine: string;
  if (lettersRemaining === 0) {
    balanceLine = "You haven't pre-paid for any letters yet. Visit letterirl.com to purchase a Letter Pack and start sending!";
  } else {
    balanceLine = `Letter Balance: ${lettersRemaining} ${lettersRemaining === 1 ? 'letter' : 'letters'} remaining.`;
  }

  // Add expiration warning if letters are expiring soon
  let expirationWarning = '';
  if (lettersExpiringSoon > 0) {
    const earliestExpiry = expiringLettersDetails[0];
    if (earliestExpiry) {
      expirationWarning = `\n⚠️ ${lettersExpiringSoon} ${lettersExpiringSoon === 1 ? 'letter' : 'letters'} expiring in ${earliestExpiry.daysUntilExpiry} days. Use them before they expire!`;
    }
  }

  const message = `${identityLine}\n${balanceLine}${expirationWarning}`;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "balance.lookup",
      lettersRemaining,
      lettersExpiringSoon,
      canSendStandardLetter,
      authProvider
    },
    "Retrieved account balance from database"
  );

  return {
    lettersRemaining,
    canSendStandardLetter,
    message,
    lettersExpiringSoon: lettersExpiringSoon > 0 ? lettersExpiringSoon : undefined,
    expiringLettersDetails: expiringLettersDetails.length > 0 ? expiringLettersDetails : undefined,
    imageGenerationsRemaining,
    imageGenerationsAllowance
  };
}

export const getAccountBalanceTool: McpToolDefinition<
  Record<string, never>,
  GetAccountBalanceOutput
> = {
  name: "get_account_balance",
  description: "Check how many pre-paid letter sends you have remaining. Visit letterirl.com to purchase more.",
  readOnly: true,
  inputSchema: getAccountBalanceInputSchema,
  outputSchema: getAccountBalanceOutputSchema,
  meta: {
    "openai/toolInvocation/invoking": "Checking letter balance…",
    "openai/toolInvocation/invoked": "Balance updated",
    readOnlyHint: true
  },
  handler
};

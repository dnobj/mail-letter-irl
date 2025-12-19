import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  getAccountBalanceInputSchema,
  getAccountBalanceOutputSchema
} from "../schemas.js";
import { getBalance, getDetailedBalance } from "../services/creditService.js";
import { findUser } from "../services/userService.js";

interface ExpiringCreditsInfo {
  amount: number;
  expiresAt: string;
  daysUntilExpiry: number;
}

interface GetAccountBalanceOutput {
  creditsRemaining: number;
  canSendStandardLetter: boolean;
  standardLetterCostCredits?: number;
  message?: string;
  userEmail?: string;
  authProvider?: string;
  creditsExpiringSoon?: number;
  expiringCreditsDetails?: ExpiringCreditsInfo[];
}

const OUTPUT_TEMPLATE = "ui://widgets/BalanceCard.html";

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

  let creditsRemaining: number;
  let creditsExpiringSoon = 0;
  let expiringCreditsDetails: ExpiringCreditsInfo[] = [];

  try {
    // Get detailed balance with expiration info
    const detailedBalance = await getDetailedBalance(userId);
    creditsRemaining = detailedBalance.totalAvailable;
    creditsExpiringSoon = detailedBalance.expiringSoon;

    // Build expiring credits details (only include buckets that expire)
    const now = new Date();
    expiringCreditsDetails = detailedBalance.expiringDates
      .filter(bucket => bucket.expiresAt !== null)
      .map(bucket => {
        const expiresAt = bucket.expiresAt as Date;
        const daysUntilExpiry = Math.ceil(
          (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );
        return {
          amount: bucket.credits,
          expiresAt: expiresAt.toISOString(),
          daysUntilExpiry
        };
      })
      .filter(info => info.daysUntilExpiry > 0); // Only future expirations
  } catch (error) {
    // User doesn't exist yet or no ledger entries
    if (error instanceof Error && error.message.includes('User not found')) {
      creditsRemaining = 0;
    } else {
      // Try simple balance as fallback
      try {
        const balance = await getBalance(userId);
        creditsRemaining = balance.credits;
      } catch {
        creditsRemaining = 0;
      }
    }
  }

  const canSendStandardLetter = creditsRemaining >= standardCost;
  const lettersRemaining = Math.floor(creditsRemaining / standardCost);

  // Enhanced message with identity information
  const identityLine = `Account: ${email} (${authProvider})`;
  let balanceLine: string;
  if (creditsRemaining === 0) {
    balanceLine = "You don't have any credits yet. Purchase credits to send letters!";
  } else {
    balanceLine = `Balance: ${creditsRemaining} credits — That's enough for ${lettersRemaining} ${lettersRemaining === 1 ? 'letter' : 'letters'}.`;
  }

  // Add expiration warning if credits are expiring soon
  let expirationWarning = '';
  if (creditsExpiringSoon > 0) {
    const earliestExpiry = expiringCreditsDetails[0];
    if (earliestExpiry) {
      expirationWarning = `\n⚠️ ${creditsExpiringSoon} credits expiring in ${earliestExpiry.daysUntilExpiry} days. Use them before they expire!`;
    }
  }

  const switchTip = "\n\nTip: Use the switch_account tool to log in with a different account.";

  const message = `${identityLine}\n${balanceLine}${expirationWarning}${switchTip}`;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "balance.lookup",
      creditsRemaining,
      creditsExpiringSoon,
      canSendStandardLetter,
      userId,
      email,
      authProvider
    },
    "Retrieved account balance from database"
  );

  return {
    creditsRemaining,
    canSendStandardLetter,
    standardLetterCostCredits: standardCost,
    message,
    userEmail: email,
    authProvider,
    creditsExpiringSoon: creditsExpiringSoon > 0 ? creditsExpiringSoon : undefined,
    expiringCreditsDetails: expiringCreditsDetails.length > 0 ? expiringCreditsDetails : undefined
  };
}

export const getAccountBalanceTool: McpToolDefinition<
  Record<string, never>,
  GetAccountBalanceOutput
> = {
  name: "get_account_balance",
  description: "Return the user's balance of Letter IRL credits.",
  readOnly: true,
  inputSchema: getAccountBalanceInputSchema,
  outputSchema: getAccountBalanceOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/toolInvocation/invoking": "Checking credits…",
    "openai/toolInvocation/invoked": "Balance updated",
    readOnlyHint: true
  },
  handler
};

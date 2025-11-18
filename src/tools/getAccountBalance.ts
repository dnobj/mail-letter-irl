import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  getAccountBalanceInputSchema,
  getAccountBalanceOutputSchema
} from "../schemas.js";
import { getBalance } from "../services/creditService.js";
import { findUser } from "../services/userService.js";

interface GetAccountBalanceOutput {
  creditsRemaining: number;
  canSendStandardLetter: boolean;
  standardLetterCostCredits?: number;
  message?: string;
  userEmail?: string;
  authProvider?: string;
}

const OUTPUT_TEMPLATE = "BalanceCard";

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
  try {
    const balance = await getBalance(userId);
    creditsRemaining = balance.credits;
  } catch (error) {
    // User doesn't exist yet, return 0 balance
    if (error.message && error.message.includes('User not found')) {
      creditsRemaining = 0;
    } else {
      throw error;
    }
  }

  const canSendStandardLetter = creditsRemaining >= standardCost;
  const lettersRemaining = Math.floor(creditsRemaining / standardCost);

  // Enhanced message with identity information
  const identityLine = `Account: ${email} (${authProvider})`;
  const balanceLine = creditsRemaining === 0
    ? "You don't have any credits yet. Purchase credits to send letters!"
    : `Balance: ${creditsRemaining} credits — That's enough for ${lettersRemaining} ${lettersRemaining === 1 ? 'letter' : 'letters'}.`;
  const switchTip = "\n\nTip: Use the switch_account tool to log in with a different account.";

  const message = `${identityLine}\n${balanceLine}${switchTip}`;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "balance.lookup",
      creditsRemaining,
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
    authProvider
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

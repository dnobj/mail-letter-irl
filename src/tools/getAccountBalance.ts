import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  getAccountBalanceInputSchema,
  getAccountBalanceOutputSchema
} from "../schemas.js";

interface GetAccountBalanceOutput {
  creditsRemaining: number;
  canSendStandardLetter: boolean;
  standardLetterCostCredits?: number;
  message?: string;
}

const OUTPUT_TEMPLATE = "BalanceCard";

async function handler(
  _input: Record<string, never>,
  context: ToolContext
): Promise<GetAccountBalanceOutput> {
  const standardCost = 1;
  const creditsRemaining = context.user.creditsRemaining;
  const canSendStandardLetter = creditsRemaining >= standardCost;
  const message = `You have ${creditsRemaining} credits remaining. That's enough for ${Math.floor(creditsRemaining)} standard letters.`;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "balance.lookup",
      creditsRemaining,
      canSendStandardLetter
    },
    "Retrieved account balance"
  );

  return {
    creditsRemaining,
    canSendStandardLetter,
    standardLetterCostCredits: standardCost,
    message
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

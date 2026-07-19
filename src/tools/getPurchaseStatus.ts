import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { getPurchaseStatusInputSchema, getPurchaseStatusOutputSchema } from '../schemas.js';
import { getPurchaseStatus } from '../services/commerceService.js';

interface GetPurchaseStatusInput {
  orderId: string;
}

async function handler(input: GetPurchaseStatusInput, context: ToolContext) {
  if (!input.orderId) throw new Error('get_purchase_status requires an orderId.');
  try {
    return await getPurchaseStatus(context.user.userId, input.orderId);
  } catch (error) {
    if ((error as { code?: string })?.code === 'PURCHASE_NOT_FOUND') {
      throw new Error('Purchase not found for your account.');
    }
    throw error;
  }
}

export const getPurchaseStatusTool: McpToolDefinition<
  GetPurchaseStatusInput,
  Awaited<ReturnType<typeof handler>>
> = {
  name: 'get_purchase_status',
  description:
    'Get the payment, fulfillment, or refund status of an owned Pay & Send or letter-pack purchase. Returns sanitized commerce state only and never exposes payment-card details.',
  readOnly: true,
  inputSchema: getPurchaseStatusInputSchema,
  outputSchema: getPurchaseStatusOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Checking purchase status...',
    'openai/toolInvocation/invoked': 'Purchase status updated',
    'openai/widgetAccessible': true
  },
  handler
};

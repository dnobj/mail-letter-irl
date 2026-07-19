import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { createMailCheckoutInputSchema, createMailCheckoutOutputSchema } from '../schemas.js';
import { createJitCheckout } from '../services/commerceService.js';

interface CreateMailCheckoutInput {
  draftId: string;
}

interface CreateMailCheckoutOutput {
  orderId: string;
  checkoutUrl?: string;
  amountCents: number;
  currency: string;
  productDescription: string;
  expiresAt?: string;
  status: string;
  reused: boolean;
  message: string;
}

function friendlyCheckoutError(error: unknown): Error {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case 'JIT_DISABLED':
      return new Error('Pay & Send is not currently available. You can still buy a letter pack.');
    case 'DRAFT_NOT_FOUND':
      return new Error('Draft not found. Please create a new letter or postcard preview.');
    case 'DRAFT_NOT_OWNED':
      return new Error('This draft does not belong to your account.');
    case 'DRAFT_EXPIRED':
    case 'DRAFT_TOO_CLOSE_TO_EXPIRY':
      return new Error(
        'This draft is expired or too close to expiry. Please create a new preview.'
      );
    case 'PREPAID_BALANCE_AVAILABLE':
      return new Error(
        'You already have enough prepaid balance to send this draft. Use the Send action.'
      );
    case 'JIT_NOT_CONFIGURED':
      return new Error('Pay & Send is temporarily unavailable. Please use a letter pack instead.');
    default:
      return error instanceof Error ? error : new Error('Unable to create Pay & Send checkout');
  }
}

async function handler(
  input: CreateMailCheckoutInput,
  context: ToolContext
): Promise<CreateMailCheckoutOutput> {
  if (!input.draftId) throw new Error('create_mail_checkout requires a draftId from a preview.');
  try {
    const result = await createJitCheckout({
      userId: context.user.userId,
      draftId: input.draftId
    });
    const pending = result.status === 'checkout_pending';
    return {
      orderId: result.orderId,
      checkoutUrl: pending ? result.checkoutUrl : undefined,
      amountCents: result.amountCents,
      currency: result.currency,
      productDescription: result.productDescription,
      expiresAt: result.expiresAt,
      status: result.status,
      reused: result.reused,
      message: pending
        ? `Pay ${result.currency.toUpperCase()} ${(result.amountCents / 100).toFixed(2)} to authorize printing and mailing this exact physical item.`
        : 'This purchase is already paid or being fulfilled. Check its purchase status instead of opening another checkout.'
    };
  } catch (error) {
    throw friendlyCheckoutError(error);
  }
}

export const createMailCheckoutTool: McpToolDefinition<
  CreateMailCheckoutInput,
  CreateMailCheckoutOutput
> = {
  name: 'create_mail_checkout',
  description:
    'Create or reuse a Stripe-hosted Pay & Send checkout for one owned letter or postcard draft. The price and physical product come only from server configuration. Successful payment authorizes the exact draft to be mailed automatically; do not call send_letter or send_postcard afterward.',
  readOnly: false,
  inputSchema: createMailCheckoutInputSchema,
  outputSchema: createMailCheckoutOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Preparing secure checkout...',
    'openai/toolInvocation/invoked': 'Pay & Send checkout ready',
    'openai/widgetAccessible': true,
    openWorldHint: true,
    idempotentHint: true
  },
  handler
};

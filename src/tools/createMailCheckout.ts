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
  const source = (error ?? {}) as { code?: string; diagnosticClass?: string; terminal?: boolean };
  // Rebuild the message, keep the classification. Returning a bare Error here
  // discarded the diagnosticClass and terminal the commerce layer attached,
  // so the server log recorded unknown_error for precisely classified faults
  // (#278 review round 4).
  const friendly = (message: string): Error =>
    Object.assign(new Error(message), {
      ...(source.code !== undefined ? { code: source.code } : {}),
      ...(source.diagnosticClass !== undefined ? { diagnosticClass: source.diagnosticClass } : {}),
      ...(source.terminal !== undefined ? { terminal: source.terminal } : {})
    });
  switch (source.code) {
    case 'JIT_DISABLED':
      return friendly('Pay & Send is not currently available. You can still buy a letter pack.');
    case 'DRAFT_NOT_OWNED':
    case 'DRAFT_NOT_FOUND':
      return friendly(
        'Draft not found for your account. Please create a new letter or postcard preview.'
      );
    case 'DRAFT_EXPIRED':
    case 'DRAFT_TOO_CLOSE_TO_EXPIRY':
      return friendly(
        'This draft is expired or too close to expiry. Please create a new preview.'
      );
    case 'PREPAID_BALANCE_AVAILABLE':
      return friendly(
        'You already have enough prepaid balance to send this draft. Use the Send action.'
      );
    case 'JIT_NOT_CONFIGURED':
      // Match the quote surface: a terminal fault must not carry retry advice
      // no retry can honor, and a blip must not read as permanent - the two
      // surfaces used to contradict each other in whichever direction (#278
      // review round 4).
      return friendly(
        source.terminal
          ? 'Pay & Send pricing is not configured. Please use a letter pack instead.'
          : 'Pay & Send is temporarily unavailable. Please try again shortly, or use a letter pack.'
      );
    default:
      return friendly('Unable to create Pay & Send checkout. Please try again.');
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

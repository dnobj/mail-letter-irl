import { CREDITS_PER_LETTER } from '../config/products.js';
import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { redeemPromoCodeInputSchema, redeemPromoCodeOutputSchema } from '../schemas.js';
import { redeemPromoCode } from '../services/promoService.js';
import { findUser } from '../services/userService.js';

interface RedeemPromoCodeInput {
  code: string;
}

interface RedeemPromoCodeOutput {
  redeemed: boolean;
  letters?: number;
  expiresAt?: string;
  message: string;
}

async function handler(
  input: RedeemPromoCodeInput,
  context: ToolContext
): Promise<RedeemPromoCodeOutput> {
  const code = typeof input?.code === 'string' ? input.code.trim() : '';
  if (!code) {
    throw new Error('redeem_promo_code requires the promo code to redeem.');
  }

  // ToolContext.user carries no email, and the redemption upserts a users row
  // that has it. Looked up the same way get_account_balance does.
  const user = await findUser(context.user.userId);

  const result = await redeemPromoCode({
    userId: context.user.userId,
    email: user?.email,
    promoCode: code
  });

  if (!result.success) {
    // Returned as a RESULT rather than thrown. A mistyped or spent code is an
    // ordinary outcome the customer can act on, not a fault - and the model
    // can only relay the reason if it arrives as data. The website's own
    // endpoint does the same, answering 400 with this exact text
    // (creditApiHandler.ts), so both surfaces say the same thing.
    //
    // The reason is forwarded rather than re-derived: every string
    // promoService produces is already customer-facing ("Promo code has
    // expired", "You have already redeemed this promo code"). A test asserts
    // no internal marker reaches the customer, which guards the direction that
    // matters without coupling this file to the service's exact wording.
    return {
      redeemed: false,
      message: result.error || 'That promo code could not be redeemed.'
    };
  }

  // The service reports CREDITS; letters are the only unit a customer sees.
  const letters = Math.floor((result.credits ?? 0) / CREDITS_PER_LETTER);
  const expiresAt = result.expiresAt ? new Date(result.expiresAt).toISOString() : undefined;

  return {
    redeemed: true,
    letters,
    expiresAt,
    message: expiresAt
      ? `Added ${letters} ${letters === 1 ? 'letter' : 'letters'} to this account. They expire on ${expiresAt.slice(0, 10)}.`
      : `Added ${letters} ${letters === 1 ? 'letter' : 'letters'} to this account.`
  };
}

export const redeemPromoCodeTool: McpToolDefinition<
  RedeemPromoCodeInput,
  RedeemPromoCodeOutput
> = {
  name: 'redeem_promo_code',
  description:
    'Redeem a promo code to add prepaid letters to the account. Returns redeemed: false with the reason when a code is invalid, expired, or already used - that is an ordinary answer, not an error. Letters must still be sent afterward.',
  readOnly: false,
  inputSchema: redeemPromoCodeInputSchema,
  outputSchema: redeemPromoCodeOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Redeeming promo code...',
    'openai/toolInvocation/invoked': 'Promo code processed',
    // Redeeming the same code twice is refused by the service and reported as
    // "already redeemed", so a repeat call has no additional effect.
    idempotentHint: true
  },
  handler
};

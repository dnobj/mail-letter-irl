import { CREDITS_PER_LETTER } from '../config/products.js';
import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { redeemPromoCodeInputSchema, redeemPromoCodeOutputSchema } from '../schemas.js';
import { redeemCode } from '../services/codeRedemptionService.js';
import { findUser } from '../services/userService.js';

interface RedeemPromoCodeInput {
  code: string;
}

interface RedeemPromoCodeOutput {
  redeemed: boolean;
  letters?: number;
  /** Gift letters granted by a gift code (docs/gift-letters.md). */
  giftLetters?: number;
  expiresAt?: string;
  message: string;
}

function lettersPhrase(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
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

  // Gift codes printed on letters and promo campaigns share this tool and
  // this box: one code field is simpler for the customer than two.
  const result = await redeemCode({
    userId: context.user.userId,
    email: user?.email,
    code
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
  const giftLetters = result.giftLetters ?? 0;
  const expiresAt = result.expiresAt ? new Date(result.expiresAt).toISOString() : undefined;

  const added: string[] = [];
  if (letters > 0) added.push(lettersPhrase(letters, 'letter'));
  if (giftLetters > 0) added.push(lettersPhrase(giftLetters, 'gift letter'));
  const what = added.length > 0 ? added.join(' and ') : 'nothing new';
  // A gift letter is sent like any other; the preview shows the card it adds.
  const giftNote =
    giftLetters > 0
      ? ' A gift letter is free to send and prints an extra page with a card for the recipient.'
      : '';
  const expiry = expiresAt ? ` ${giftLetters > 0 && letters === 0 ? 'It expires' : 'They expire'} on ${expiresAt.slice(0, 10)}.` : '';

  return {
    redeemed: true,
    letters,
    giftLetters: giftLetters > 0 ? giftLetters : undefined,
    expiresAt,
    message: `Added ${what} to this account.${expiry}${giftNote}`
  };
}

export const redeemPromoCodeTool: McpToolDefinition<
  RedeemPromoCodeInput,
  RedeemPromoCodeOutput
> = {
  name: 'redeem_promo_code',
  title: 'Redeem a promo or gift code',
  description:
    'Redeem a promo code or a gift code from a printed letter to add letters to the account. Returns redeemed: false with the reason when a code is invalid, expired, or already used - that is an ordinary answer, not an error. Letters must still be sent afterward.',
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

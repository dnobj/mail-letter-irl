/**
 * One entry point for every code a person can type or scan: the MCP tool, the
 * dashboard's promo box and the claim page all call this.
 *
 * Chain codes (docs/gift-letters.md) are tried first because their shape is
 * fixed and a lookup is one primary-key read. Anything that is not an
 * existing chain code goes to promo campaigns, which covers ordinary codes
 * and seed campaigns. Kept out of giftLetterService because promoService
 * imports that module, and this one needs both.
 */

import { redeemChainCode, type CodeRedemptionResult } from './giftLetterService.js';
import { redeemPromoCode } from './promoService.js';

export async function redeemCode(params: {
  userId: string;
  email?: string | null;
  code: string;
}): Promise<CodeRedemptionResult> {
  const chain = await redeemChainCode({
    userId: params.userId,
    email: params.email,
    rawCode: params.code
  });
  if (chain) return chain;

  const promo = await redeemPromoCode({
    userId: params.userId,
    email: params.email ?? undefined,
    promoCode: params.code
  });
  return {
    success: promo.success,
    credits: promo.credits,
    giftLetters: promo.giftLetters,
    expiresAt: promo.expiresAt,
    error: promo.error
  };
}

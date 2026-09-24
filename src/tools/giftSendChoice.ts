/**
 * Whether a preview becomes a gift send (docs/gift-letters.md).
 *
 * Decided at preview time, not at send, because the preview has to show the
 * extra page that will print. The draft records the answer and the send
 * honours it. When the caller does not say, a gift letter is used only if the
 * balance cannot pay: someone with letters in hand is never switched to a gift
 * without asking, and someone with only a gift letter is not told they cannot
 * send.
 */

import { isGiftLettersEnabled } from '../config/giftLetters.js';
import {
  getGiftBalance,
  sampleFundedCard,
  seedCard,
  unfundedCard,
  type GiftBalanceSeed
} from '../services/giftLetterService.js';
import type { GiftCardContent, GiftCardState } from '../services/giftCardRenderer.js';

export interface GiftSendChoice {
  isGift: boolean;
  /**
   * The card the send will print: a seed campaign's own code, or, for a chain
   * code that does not exist until the send, a placeholder.
   */
  card?: GiftCardContent;
  /** Unsent gift letters on the account, for the preview's note. */
  giftLettersAvailable: number;
}

/**
 * The funded card a preview draws: the seed campaign's own card when the next
 * gift letter prints one (#433), so the preview matches the print; otherwise
 * the chain-code placeholder.
 */
function fundedPreviewCard(seed: GiftBalanceSeed | undefined): GiftCardContent {
  return seed ? seedCard(seed.code, seed.endsAt, seed.newAccountsOnly) : sampleFundedCard();
}

export async function resolveGiftSendChoice(params: {
  userId: string;
  requested: boolean | undefined;
  balanceCanPay: boolean;
}): Promise<GiftSendChoice> {
  if (!isGiftLettersEnabled()) {
    if (params.requested === true) {
      throw new Error('Gift letters are not available right now. Leave sendAsGift out to send from the balance.');
    }
    return { isGift: false, giftLettersAvailable: 0 };
  }
  const balance = await getGiftBalance(params.userId);
  if (params.requested === true && balance.available === 0) {
    throw new Error('This account has no gift letter to send. Leave sendAsGift out to send from the balance.');
  }
  const isGift =
    params.requested === true ||
    (params.requested === undefined && balance.available > 0 && !params.balanceCanPay);
  if (!isGift) return { isGift: false, giftLettersAvailable: balance.available };
  const state = balance.next?.cardState ?? 'funded';
  return {
    isGift: true,
    card: state === 'funded' ? fundedPreviewCard(balance.next?.seed) : unfundedCard(),
    giftLettersAvailable: balance.available
  };
}

/**
 * The preview's structured summary of the card, for the model and the card.
 * A letter gets an extra page; a postcard gets a strip across the foot of the
 * message side.
 */
export function giftCardSummary(
  state: GiftCardState,
  mailType: 'letter' | 'postcard' = 'letter'
): { state: GiftCardState; description: string } {
  const where =
    mailType === 'postcard'
      ? 'A strip at the foot of the message side carries'
      : 'An extra page prints with';
  return {
    state,
    description:
      state === 'funded'
        ? `Sent free as a gift letter. ${where} a card for the recipient with a code for a free letter of their own.`
        : `Sent free as a gift letter. ${where} a note that it was sent with Letter IRL.`
  };
}

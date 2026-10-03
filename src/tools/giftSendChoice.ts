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
import { LONGEST_REDEEM_BY, type GiftCardContent, type GiftCardState } from '../services/giftCardRenderer.js';

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

/** The refusal of a gift for mail no gift letter pays for (#579): a signed letter adds its way out (#608). */
export const GIFT_PAYS_ONE_PAGE =
  'A gift letter pays for a one-page letter or a 6x9 postcard, not for this one. ' +
  'Leave sendAsGift out and pay for it with Pay & Send, or send a 6x9 postcard or a one-page letter as the gift.';

/** The refusal of a gift for certified mail (#625): no gift letter pays for it, however many pages it has. */
export const GIFT_NOT_FOR_CERTIFIED =
  'A gift letter does not pay for certified mail. ' +
  'Leave sendAsGift out and pay for it with Pay & Send, or send the gift as an ordinary one-page letter or a 6x9 postcard.';

export async function resolveGiftSendChoice(params: {
  userId: string;
  requested: boolean | undefined;
  balanceCanPay: boolean;
  /**
   * Whether a gift letter could pay for this mail: like a pack, only a
   * one-page letter or a 6x9 postcard (#579). Otherwise the mail is paid with
   * Pay & Send, so no gift is chosen for it, and asking for one is refused.
   */
  giftCanPay?: boolean;
  /** Whether the mail asks for certified mail (#625): the refusal then says so, not that the letter is long. */
  certified?: boolean;
}): Promise<GiftSendChoice> {
  if (!isGiftLettersEnabled()) {
    if (params.requested === true) {
      throw new Error(
        params.certified === true
          ? 'Gift letters are not available right now. Leave sendAsGift out and pay for it with Pay & Send.'
          : 'Gift letters are not available right now. Leave sendAsGift out to send from the balance.'
      );
    }
    return { isGift: false, giftLettersAvailable: 0 };
  }
  if (params.giftCanPay === false) {
    if (params.requested === true) {
      throw new Error(params.certified === true ? GIFT_NOT_FOR_CERTIFIED : GIFT_PAYS_ONE_PAGE);
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
 * The longest card a send could print in place of this preview's. The send
 * decides the card (consumeGiftLetterForSendWithClient), so its date, its
 * wording and even whether it is funded can change after the preview: this
 * one is funded, prints the longest date and the seed campaign's longest
 * wording, and keeps the preview's code. A postcard's strip, whose room is
 * fixed, is checked against it (#534).
 */
export function longestSendCard(card: GiftCardContent): GiftCardContent {
  return {
    ...(card.state === 'funded' ? card : sampleFundedCard()),
    redeemBy: LONGEST_REDEEM_BY,
    multiUse: true,
    newAccountsOnly: true
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

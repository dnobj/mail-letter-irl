/**
 * A gift letter pays only where a pack does (#579): a one-page letter or a 6x9
 * postcard. For any other mail the preview never chooses a gift, and asking
 * for one is refused with the way to pay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getGiftBalance = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance
}));

import { resolveGiftSendChoice } from '../../../src/tools/giftSendChoice.js';

beforeEach(() => {
  vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
  getGiftBalance.mockReset();
  getGiftBalance.mockResolvedValue({ available: 2, next: { giftId: 'gift-1', cardState: 'funded' } });
});

afterEach(() => vi.unstubAllEnvs());

describe('a gift for mail no gift letter pays for (#579)', () => {
  it('refuses a gift asked for, saying how it is paid instead, before reading the gift balance', async () => {
    await expect(
      resolveGiftSendChoice({ userId: 'user-1', requested: true, balanceCanPay: false, giftCanPay: false })
    ).rejects.toThrow(
      'A gift letter pays for a one-page letter or a 6x9 postcard, not for this one. ' +
        'Leave sendAsGift out and pay for it with Pay & Send, or send a 6x9 postcard or a one-page letter as the gift.'
    );
    expect(getGiftBalance).not.toHaveBeenCalled();
  });

  it('never chooses a gift on its own, though the balance cannot pay and a gift letter is there', async () => {
    await expect(
      resolveGiftSendChoice({ userId: 'user-1', requested: undefined, balanceCanPay: false, giftCanPay: false })
    ).resolves.toEqual({ isGift: false, giftLettersAvailable: 0 });
  });

  it('chooses one as before where a gift letter pays, by default too', async () => {
    await expect(
      resolveGiftSendChoice({ userId: 'user-1', requested: undefined, balanceCanPay: false, giftCanPay: true })
    ).resolves.toMatchObject({ isGift: true, giftLettersAvailable: 2 });
    await expect(
      resolveGiftSendChoice({ userId: 'user-1', requested: undefined, balanceCanPay: false })
    ).resolves.toMatchObject({ isGift: true });
  });

  it('keeps the off switch first: gift letters off says so, whatever the mail', async () => {
    vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'false');
    await expect(
      resolveGiftSendChoice({ userId: 'user-1', requested: true, balanceCanPay: false, giftCanPay: false })
    ).rejects.toThrow('Gift letters are not available right now.');
  });
});

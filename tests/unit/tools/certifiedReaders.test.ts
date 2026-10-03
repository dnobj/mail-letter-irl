/**
 * Certified mail (#625), the readers of a draft's option: everything that
 * prices a letter reads its mail service beside its pages, so a certified
 * letter is never priced, paid for or given away as standard mail.
 *
 * The helpers are tested here; the tools that call them (the restyles, the
 * status read) have their own cases beside their other tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/giftLetterService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/giftLetterService.js')>()),
  getGiftBalance: vi.fn()
}));

import { getGiftBalance } from '../../../src/services/giftLetterService.js';
import {
  CERTIFIED_PAID_PER_SEND_REASON,
  PAID_PER_SEND_REASON,
  earlyGiftChoice,
  letterOption,
  pageChangeSentence,
  reasonCannotSend
} from '../../../src/tools/letterHelpers.js';
import { GIFT_NOT_FOR_CERTIFIED, GIFT_PAYS_ONE_PAGE } from '../../../src/tools/giftSendChoice.js';
import type { ToolContext } from '../../../src/contracts/types.js';

/** Only a layout's page count is read. */
const layoutOf = (pages: number) => ({ pages: Array.from({ length: pages }, () => ({})) }) as never;

const context = (creditsRemaining = 0): ToolContext =>
  ({ user: { userId: 'user-1', creditsRemaining, orders: [] }, logger: { info: vi.fn() } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getGiftBalance).mockResolvedValue({ available: 2, next: undefined } as never);
  vi.stubEnv('LETTER_IRL_GIFT_LETTERS_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('letterOption reads the draft service beside the pages (#625)', () => {
  it.each([
    [1, undefined, { mailType: 'letter' }],
    [1, null, { mailType: 'letter' }],
    [1, '', { mailType: 'letter' }],
    [1, 'standard', { mailType: 'letter' }],
    [2, 'standard', { mailType: 'letter', pages: 2 }],
    [1, 'certified', { mailType: 'letter', mailService: 'certified' }],
    [3, 'certified_return_receipt', { mailType: 'letter', pages: 3, mailService: 'certified_return_receipt' }],
    // Text this code does not know is carried, so it prices as nothing and is never read as standard mail.
    [1, 'express', { mailType: 'letter', mailService: 'express' }]
  ])('%i page(s) and %j is %j', (pages, service, option) => {
    expect(letterOption(layoutOf(pages), service)).toEqual(option);
  });

  it('is a one-page letter with no layout, and keeps the service', () => {
    expect(letterOption(undefined)).toEqual({ mailType: 'letter' });
    expect(letterOption(undefined, 'certified')).toEqual({ mailType: 'letter', mailService: 'certified' });
  });
});

describe('reasonCannotSend names why a certified letter is not paid from the balance (#625)', () => {
  it.each([
    [{ mailType: 'letter' }, 'Not enough letters in your balance.'],
    [{ mailType: 'letter', pages: 2 }, PAID_PER_SEND_REASON],
    [{ mailType: 'postcard', postcardSize: '4x6' }, PAID_PER_SEND_REASON],
    [{ mailType: 'letter', mailService: 'certified' }, CERTIFIED_PAID_PER_SEND_REASON],
    [{ mailType: 'letter', pages: 3, mailService: 'certified_return_receipt' }, CERTIFIED_PAID_PER_SEND_REASON],
    [{ mailType: 'letter', mailService: 'express' }, CERTIFIED_PAID_PER_SEND_REASON]
  ])('%j', (option, reason) => {
    expect(reasonCannotSend(option as never)).toBe(reason);
  });

  it('says it in words, once, without naming a price', () => {
    expect(CERTIFIED_PAID_PER_SEND_REASON).toBe('Certified mail is paid with Pay & Send.');
  });
});

describe('no gift letter pays for certified mail (#625)', () => {
  it.each(['certified', 'certified_return_receipt'])('refuses a gift asked for %s, saying why', async service => {
    await expect(earlyGiftChoice({ bodyText: 'Dear Sam', signOff: 'Pat', sendAsGift: true }, context(), service)).rejects.toThrow(
      GIFT_NOT_FOR_CERTIFIED
    );
    expect(GIFT_NOT_FOR_CERTIFIED).not.toBe(GIFT_PAYS_ONE_PAGE);
    expect(GIFT_NOT_FOR_CERTIFIED).toBe(
      'A gift letter does not pay for certified mail. ' +
        'Leave sendAsGift out and pay for it with Pay & Send, or send the gift as an ordinary one-page letter or a 6x9 postcard.'
    );
  });

  it('decides at once whatever room to write offers, and chooses no gift when none was asked for, though one is waiting', async () => {
    for (const roomToWrite of ['', 'true']) {
      vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', roomToWrite);
      vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
      vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
      // An empty balance with a gift letter waiting: a standard letter would be given away.
      const choice = await earlyGiftChoice({ bodyText: 'Dear Sam', signOff: 'Pat' }, context(0), 'certified');
      expect(choice, roomToWrite).toEqual({ isGift: false, giftLettersAvailable: 0 });
    }
  });

  it('is unchanged for a letter with no service, however it is written', async () => {
    // Room to write off: decided now, and the gift letter pays for an empty balance.
    for (const service of [undefined, null, '', 'standard']) {
      const choice = await earlyGiftChoice({ bodyText: 'Dear Sam', signOff: 'Pat' }, context(0), service);
      expect(choice, String(service)).toMatchObject({ isGift: true });
    }
    // Room to write on: left for the layout to decide, by its pages.
    vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    await expect(earlyGiftChoice({ bodyText: 'Dear Sam', signOff: 'Pat' }, context(0), 'standard')).resolves.toBeUndefined();
    await expect(earlyGiftChoice({ bodyText: 'Dear Sam', signOff: 'Pat' }, context(0))).resolves.toBeUndefined();
  });
});

describe('a change of pages says who pays only where it changes who pays (#625)', () => {
  it.each([
    [1, 1, undefined, ''],
    [2, 2, 'certified', ''],
    [2, 1, undefined, ' It now runs to two pages, printed on both sides, and is paid with Pay & Send.'],
    [3, 2, 'standard', ' It now runs to three pages, printed on both sides, and is paid with Pay & Send.'],
    [3, 1, null, ' It now runs to three pages, printed on both sides, and is paid with Pay & Send.'],
    [1, 2, '', ' It now fits on one page, which a letter pack pays for.'],
    [2, 1, 'certified', ' It now runs to two pages, printed on both sides. The price is the same.'],
    [3, 2, 'certified_return_receipt', ' It now runs to three pages, printed on both sides. The price is the same.'],
    [1, 3, 'certified', ' It now fits on one page.'],
    [1, 2, 'express', ' It now fits on one page.']
  ])('%i pages after %i, service %j', (pages, before, service, sentence) => {
    expect(pageChangeSentence(pages, before, service)).toBe(sentence);
  });
});

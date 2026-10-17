import { describe, expect, it } from 'vitest';

import {
  drawPrintPdf,
  letterPages,
  letterPrintLayout,
  postcardPrintLayout,
  RenderRefusal
} from '../../../src/services/printDocument.js';
import {
  layoutGiftPage,
  layoutLetter,
  layoutPostcard,
  readImageDataUri,
  RENDERER_VERSION,
  renderPdf,
  STATIONERY_RENDERER_VERSION
} from '../../../src/render/index.js';
import { giftLetterPageCopy } from '../../../src/services/giftCardRenderer.js';

/**
 * What a letter or a postcard prints as (#697): the one place the print and
 * the send lay mail out, so the send can record what the print will draw. The
 * provider's own PDF tests (postGridPdfLetters, postGridPdfPostcards) prove the
 * print uses it; these pin the layouts and versions it gives.
 */

const letter = {
  idempotencyKey: 'letter-stable-id',
  recipientName: 'Sam Rivera',
  recipientAddress: { line1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118' },
  senderName: 'Test Sender',
  message: 'Dear Sam,\n\nHappy birthday.\n\nWarmly,\nTest',
  layoutType: 'text_only' as const,
  rendererVersion: RENDERER_VERSION
};

const GIFT_CARD = {
  state: 'funded' as const,
  code: 'K7M2QX9A',
  url: 'https://letterirl.com/g/K7M2QX9A',
  displayUrl: 'letterirl.com/g',
  redeemBy: '2026-12-16'
};

/** A 1x1 grey PNG, as the postcard front. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';

describe('letterPrintLayout (#697)', () => {
  it('lays a letter out as the preview does, with the version its PDF names', () => {
    const print = letterPrintLayout(letter as never, 1);
    expect(print.rendererVersion).toBe(RENDERER_VERSION);
    expect(print.layout).toEqual(layoutLetter({ text: letter.message, layoutType: 'text_only', image: undefined, stationery: undefined, signature: undefined }, { maxPages: 3 }));
  });

  it("puts a gift send's card on the page after the letter", () => {
    const print = letterPrintLayout({ ...letter, giftCard: GIFT_CARD } as never, 1);
    expect(print.layout.pages).toHaveLength(2);
    expect(print.layout.pages[1]).toEqual(layoutGiftPage(giftLetterPageCopy(GIFT_CARD, 'Test Sender')).valueOf());
  });

  it('names the stationery version for a themed letter', () => {
    const print = letterPrintLayout({ ...letter, rendererVersion: STATIONERY_RENDERER_VERSION, stationery: { theme: 'monogram' } } as never, 1);
    expect(print.rendererVersion).toBe(STATIONERY_RENDERER_VERSION);
  });

  it('refuses a letter that lays out on other pages than it was previewed on', () => {
    expect(() => letterPrintLayout(letter as never, 2)).toThrow(RenderRefusal);
    try {
      letterPrintLayout(letter as never, 2);
    } catch (error) {
      expect((error as RenderRefusal).reason).toBe('overflow');
    }
  });

  it('refuses a page count it cannot print', () => {
    expect(() => letterPages({ ...letter, pages: 4 } as never, true)).toThrow(RenderRefusal);
    expect(() => letterPages({ ...letter, pages: 2 } as never, false)).toThrow(RenderRefusal);
    expect(() => letterPages({ ...letter, pages: 2, giftCard: GIFT_CARD } as never, true)).toThrow(RenderRefusal);
    expect(letterPages({ ...letter, pages: 3 } as never, true)).toBe(3);
  });
});

describe('postcardPrintLayout (#697)', () => {
  it('lays a postcard out as the preview does', () => {
    const print = postcardPrintLayout({ frontImageBase64: PNG, backMessage: 'Hi Sam', rendererVersion: RENDERER_VERSION } as never, '6x9');
    expect(print.rendererVersion).toBe(RENDERER_VERSION);
    expect(print.layout).toEqual(layoutPostcard({ message: 'Hi Sam', image: readImageDataUri(PNG), strip: undefined, size: '6x9' }));
  });

  it('refuses a gift card on any postcard but a 6x9', () => {
    expect(() => postcardPrintLayout({ frontImageBase64: PNG, backMessage: 'Hi', giftCard: GIFT_CARD } as never, '6x4')).toThrow(RenderRefusal);
  });
});

describe('drawPrintPdf (#697)', () => {
  it('is the PDF of the layout at its version', async () => {
    const print = letterPrintLayout(letter as never, 1);
    const drawn = await drawPrintPdf(print, 'letter');
    expect(drawn.equals(await renderPdf(print.layout, print.rendererVersion))).toBe(true);
  });
});

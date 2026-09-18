import jsQR from 'jsqr';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';
import type { GiftCardContent } from '../../../src/services/giftCardRenderer.js';
import { readFileSync } from 'node:fs';
import { renderLayoutPreviewHtml } from '../../../src/services/previewService.js';
import { generatePreviewBackHtml } from '../../../src/tools/quoteAndPreviewPostcard.js';

const BASELINE: Record<string, string> = JSON.parse(
  readFileSync(new URL('../../fixtures/nonGiftPrintHtml.385578d.json', import.meta.url), 'utf8')
);

/**
 * What PostGrid is actually sent for a gift letter (docs/gift-letters.md):
 * an extra page with the card, and nothing different for any other letter.
 */

function provider() {
  return new PostGridProvider(
    { name: 'postgrid', displayName: 'PostGrid', enabled: true },
    { apiKey: 'test-key', verbose: false, timeoutMs: 100 }
  );
}

const address = { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' };
const letter = {
  idempotencyKey: 'letter-1',
  recipientName: 'Grandma',
  recipientAddress: address,
  senderName: 'Sarah Johnson',
  senderAddress: address,
  message: 'Hello from Austin\nLove, Sarah'
};

const card: GiftCardContent = {
  state: 'funded',
  code: 'K7M2QX9A',
  url: 'https://letterirl.com/g/K7M2QX9A',
  displayUrl: 'letterirl.com/g',
  redeemBy: '2026-12-16'
};

let bodies: any[];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({ id: 'provider-1', status: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LETTER_IRL_GIFT_QR_FORMAT;
});

async function decodeFirstSvg(html: string): Promise<string | null> {
  const svg = html.match(/<svg[\s\S]*?<\/svg>/)?.[0];
  if (!svg) return null;
  const sized = svg.replace(/width="[^"]+" height="[^"]+"/, 'width="480" height="480"');
  const { data, info } = await sharp(Buffer.from(sized)).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

describe('PostGrid gift card', () => {
  it.each(['text_only', 'header_image', 'inline_image'] as const)(
    'adds the card page to a %s letter, after the letter, with a QR that opens the claim page',
    async layoutType => {
      await provider().sendLetter({ ...letter, layoutType, giftCard: card });
      const html: string = bodies[0].html;
      const bodyAt = html.indexOf('class="letter-body"');
      const pageAt = html.indexOf('class="gift-page"');
      expect(bodyAt).toBeGreaterThan(-1);
      expect(pageAt).toBeGreaterThan(bodyAt);
      expect(html).toContain('page-break-before: always');
      expect(html).toContain('K7M2-QX9A');
      expect(await decodeFirstSvg(html)).toBe('https://letterirl.com/g/K7M2QX9A');
    }
  );

  it('keeps a gift letter in black and white: the card is not an image layout', async () => {
    await provider().sendLetter({ ...letter, layoutType: 'text_only', giftCard: card });
    expect(bodies[0].color).toBe(false);
    expect(bodies[0].doubleSided).toBe(false);
    expect(bodies[0].addressPlacement).toBe('top_first_page');
  });

  it('sends every other letter byte for byte as the code before gift letters did', async () => {
    // BASELINE was produced by commit 385578d, the parent of the gift letter
    // change, from these same inputs (tests/fixtures/nonGiftPrintHtml.385578d.json).
    const baselineLetter = { ...letter, senderName: 'Sarah & <Co>', message: 'Hello "there"\nLove, Sarah' };
    await provider().sendLetter({ ...baselineLetter, layoutType: 'text_only' });
    await provider().sendLetter({ ...baselineLetter, layoutType: 'header_image', headerImageData: 'data:image/jpeg;base64,AAAA' });
    await provider().sendLetter({ ...baselineLetter, layoutType: 'inline_image', inlineImageData: 'data:image/jpeg;base64,BBBB' });
    expect(bodies[0].html).toBe(BASELINE.letter_text_only);
    expect(bodies[1].html).toBe(BASELINE.letter_header_image);
    expect(bodies[2].html).toBe(BASELINE.letter_inline_image);
  });

  it('previews every other letter byte for byte as before', () => {
    const sender = { name: 'Sarah', addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' };
    for (const layoutType of ['text_only', 'header_image', 'inline_image'] as const) {
      const html = renderLayoutPreviewHtml({
        sender,
        recipient: { ...sender, name: 'Grandma' },
        bodyText: 'Hello there\n\n',
        signOff: 'Love, Sarah',
        layoutType,
        headerImageData: 'data:image/jpeg;base64,AAAA',
        inlineImageData: 'data:image/jpeg;base64,BBBB'
      });
      expect(html).toBe(BASELINE[`preview_${layoutType}`]);
    }
  });

  it('embeds a PNG when the SVG fallback is switched off', async () => {
    process.env.LETTER_IRL_GIFT_QR_FORMAT = 'png';
    await provider().sendLetter({ ...letter, layoutType: 'text_only', giftCard: card });
    expect(bodies[0].html).toContain('src="data:image/png;base64,');
    expect(bodies[0].html).not.toContain('<svg');
  });

  it('previews every other postcard back byte for byte as before', () => {
    const html = generatePreviewBackHtml('Wish you <were> here' + String.fromCharCode(10) + 'See you soon', {
      name: 'Sarah & Co',
      addressLine1: '1 Main St',
      addressLine2: 'Apt 2',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US'
    });
    expect(html).toBe(BASELINE.preview_postcard_back);
  });

  it('puts the card at the foot of the postcard message half, and nowhere else changes', async () => {
    const postcard = {
      idempotencyKey: 'postcard-1',
      recipientName: 'Grandma',
      recipientAddress: address,
      senderName: 'Sarah Johnson',
      senderAddress: address,
      frontImageBase64: 'data:image/jpeg;base64,AAAA',
      backMessage: 'Wish you were here',
      size: '6x9' as const
    };
    await provider().sendPostcard({ ...postcard, giftCard: card });
    const back: string = bodies[0].backHTML;
    expect(back.indexOf('class="gift-block"')).toBeGreaterThan(back.indexOf('class="message"'));
    expect(back).toContain('.message-area { flex-direction: column;');
    expect(await decodeFirstSvg(back)).toBe('https://letterirl.com/g/K7M2QX9A');

    await provider().sendPostcard({
      ...postcard,
      senderName: 'Sarah',
      frontImageBase64: 'data:image/jpeg;base64,CCCC',
      backMessage: 'Wish you <were> here'
    });
    expect(bodies[1].backHTML).toBe(BASELINE.postcard_back);
    expect(bodies[1].frontHTML).toBe(BASELINE.postcard_front);
  });
});

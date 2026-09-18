import jsQR from 'jsqr';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostGridProvider } from '../../../src/services/providers/PostGridProvider.js';
import type { GiftCardContent } from '../../../src/services/giftCardRenderer.js';

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

  it('sends every other letter exactly as before', async () => {
    await provider().sendLetter({ ...letter, layoutType: 'text_only' });
    expect(bodies[0].html).not.toMatch(/gift-|<svg/);
  });

  it('embeds a PNG when the SVG fallback is switched off', async () => {
    process.env.LETTER_IRL_GIFT_QR_FORMAT = 'png';
    await provider().sendLetter({ ...letter, layoutType: 'text_only', giftCard: card });
    expect(bodies[0].html).toContain('src="data:image/png;base64,');
    expect(bodies[0].html).not.toContain('<svg');
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

    await provider().sendPostcard(postcard);
    expect(bodies[1].backHTML).not.toMatch(/gift-|<svg|flex-direction: column/);
    expect(bodies[1].frontHTML).toBe(bodies[0].frontHTML);
  });
});

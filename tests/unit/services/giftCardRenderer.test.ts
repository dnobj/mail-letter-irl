import jsQR from 'jsqr';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  buildGiftLetterPage,
  buildGiftPostcardBlock,
  giftLetterPageSvg,
  giftPostcardBlockSvg,
  qrPngDataUri,
  qrSvg,
  type GiftCardContent
} from '../../../src/services/giftCardRenderer.js';

/**
 * The printed card (docs/gift-letters.md). The property that matters most is
 * that the symbol decodes to the link: nothing short of a decoder can assert
 * it, so these rasterise the exact markup we print and read it back.
 */

const CLAIM_URL = 'https://letterirl.com/g/K7M2QX9A';

async function decodeSvg(svg: string, pixels = 480): Promise<string | null> {
  const sized = svg.replace(/width="[^"]+" height="[^"]+"/, `width="${pixels}" height="${pixels}"`);
  const { data, info } = await sharp(Buffer.from(sized))
    .flatten({ background: '#ffffff' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

async function decodePngDataUri(uri: string): Promise<string | null> {
  const png = Buffer.from(uri.replace(/^data:image\/png;base64,/, ''), 'base64');
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

const funded: GiftCardContent = {
  state: 'funded',
  code: 'K7M2QX9A',
  url: CLAIM_URL,
  displayUrl: 'letterirl.com/g',
  redeemBy: '2026-12-16'
};

const unfunded: GiftCardContent = {
  state: 'unfunded',
  url: 'https://letterirl.com',
  displayUrl: 'letterirl.com'
};

describe('gift card QR', () => {
  it('decodes to the claim link, as SVG and as the PNG fallback', async () => {
    expect(await decodeSvg(qrSvg(CLAIM_URL, 1.4))).toBe(CLAIM_URL);
    expect(await decodePngDataUri(await qrPngDataUri(CLAIM_URL))).toBe(CLAIM_URL);
  });

  it('decodes a seed campaign link and the plain card link', async () => {
    expect(await decodeSvg(qrSvg('https://letterirl.com/g/JANE-SMITH', 1))).toBe('https://letterirl.com/g/JANE-SMITH');
    expect(await decodeSvg(qrSvg('https://letterirl.com', 1))).toBe('https://letterirl.com');
  });

  it('is sized in inches, draws a white quiet zone, and is deterministic', () => {
    const svg = qrSvg(CLAIM_URL, 1.4);
    expect(svg).toContain('width="1.4in" height="1.4in"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    // A 32-character URL at ECC Q is version 3: 29 modules plus 4 each side.
    expect(svg).toContain('viewBox="0 0 37 37"');
    expect(svg).toMatch(/<rect width="37" height="37" fill="#fff"\/>/);
    // No dark module sits in the quiet zone.
    for (const match of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)"/g)) {
      const [x, y, width] = [Number(match[1]), Number(match[2]), Number(match[3])];
      expect(x).toBeGreaterThanOrEqual(4);
      expect(y).toBeGreaterThanOrEqual(4);
      expect(x + width).toBeLessThanOrEqual(33);
      expect(y).toBeLessThan(33);
    }
    expect(qrSvg(CLAIM_URL, 1.4)).toBe(svg);
  });
});

describe('gift card markup', () => {
  it('prints the code in two groups, the typed address, and the redeem-by date', () => {
    const page = giftLetterPageSvg(funded, 'Sarah Johnson');
    expect(page.html).toContain('K7M2-QX9A');
    expect(page.html).toContain('letterirl.com/g');
    expect(page.html).toContain('Redeem by December 16, 2026.');
    expect(page.html).toContain('Sarah Johnson sent this letter');
    expect(page.css).toContain('page-break-before: always');
  });

  it('prints a placeholder, never a code, on a preview', () => {
    const page = giftLetterPageSvg({ ...funded, code: undefined, sample: true }, 'Sarah');
    expect(page.html).toContain('••••-••••');
    expect(page.html).not.toContain('K7M2');
  });

  it('prints a seed campaign code as the operator chose it', () => {
    const page = giftLetterPageSvg({ ...funded, code: 'JANE-SMITH', url: 'https://letterirl.com/g/JANE-SMITH' }, 'Jane');
    expect(page.html).toContain('>JANE-SMITH<');
  });

  it('tells the readers of a shared seed code it works once each, never once in all', () => {
    // A seed letter is photographed and shared on purpose (GIFT-01 step 9
    // printed "The code works once." on one, 2026-09-23).
    const seed: GiftCardContent = { ...funded, code: 'JANE-SMITH', url: 'https://letterirl.com/g/JANE-SMITH', multiUse: true };
    const page = giftLetterPageSvg(seed, 'Jane');
    expect(page.html).toContain('Each person can use the code once, while it lasts.');
    expect(page.html).not.toContain('The code works once.');
    const block = giftPostcardBlockSvg(seed, 'Jane');
    expect(block.html).toContain('One use per person, while it lasts.');
    expect(block.html).not.toContain('One use.');
  });

  it('says when a shared seed code is for new accounts only, and only then', () => {
    // Otherwise an existing customer who finds the letter is promised a claim
    // the redeem path refuses (review round 1 on #431).
    const seed: GiftCardContent = { ...funded, code: 'JANE-SMITH', url: 'https://letterirl.com/g/JANE-SMITH', multiUse: true };
    const page = giftLetterPageSvg({ ...seed, newAccountsOnly: true }, 'Jane');
    expect(page.html).toContain('For new Letter IRL accounts. Each person can use the code once, while it lasts.');
    const block = giftPostcardBlockSvg({ ...seed, newAccountsOnly: true }, 'Jane');
    expect(block.html).toContain('New accounts only. One use per person, while it lasts.');
    expect(giftLetterPageSvg(seed, 'Jane').html).not.toContain('new Letter IRL accounts');
    expect(giftPostcardBlockSvg(seed, 'Jane').html).not.toContain('New accounts only.');
  });

  it('keeps the single-use wording on a chain code', () => {
    expect(giftLetterPageSvg(funded, 'Sarah').html).toContain('The code works once.');
    expect(giftPostcardBlockSvg(funded, 'Sarah').html).toContain('One use.');
    expect(giftLetterPageSvg(funded, 'Sarah').html).not.toContain('Each person');
  });

  it('prints the plain card with no code and no gift promise', () => {
    const page = giftLetterPageSvg(unfunded, 'Sarah');
    expect(page.html).toContain('Sent with Letter IRL');
    expect(page.html).not.toContain('gift-code');
    expect(page.html).not.toMatch(/free letter|a letter for you to send/i);
  });

  it('escapes the sender name, which is customer input', () => {
    const page = giftLetterPageSvg(funded, '<img src=x onerror=alert(1)>');
    expect(page.html).not.toContain('<img src=x');
    expect(page.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const block = giftPostcardBlockSvg(funded, '"><script>');
    expect(block.html).not.toContain('<script>');
  });

  it('never reuses the class names the preview card parses the letter out of', () => {
    // LetterPreviewCard extracts the body and sign-off by these classes; a
    // card that reused either would put the gift text into the letter.
    for (const fragment of [giftLetterPageSvg(funded, 'S'), giftLetterPageSvg(unfunded, 'S')]) {
      expect(fragment.html).not.toContain('class="letter-body"');
      expect(fragment.html).not.toContain('class="sign-off"');
    }
  });

  it('builds the print fragments with the configured QR format', async () => {
    const svgPage = await buildGiftLetterPage(funded, 'Sarah', 'svg');
    expect(svgPage.html).toContain('<svg');
    const pngPage = await buildGiftLetterPage(funded, 'Sarah', 'png');
    expect(pngPage.html).toContain('src="data:image/png;base64,');
    expect(pngPage.html).not.toContain('<svg');
    const block = await buildGiftPostcardBlock(funded, 'Sarah', 'svg');
    expect(block.html).toContain('K7M2-QX9A');
    // The postcard override lives in the gift CSS only.
    expect(block.css).toContain('.message-area { flex-direction: column;');
  });
});

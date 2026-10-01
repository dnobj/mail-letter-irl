import jsQR from 'jsqr';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  buildGiftLetterPage,
  buildGiftPostcardBlock,
  giftLetterPageCopy,
  giftLetterPageSvg,
  giftPostcardBlockSvg,
  giftPostcardStripCopy,
  LONGEST_REDEEM_BY,
  qrPngDataUri,
  qrSvg,
  type GiftCardContent
} from '../../../src/services/giftCardRenderer.js';
import { loadFont } from '../../../src/render/fonts.js';
import { shape } from '../../../src/render/glyphs.js';

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

  it('says when a shared seed code is for new customers only, and only then', () => {
    // Otherwise an existing customer who finds the letter is promised a claim
    // the redeem path refuses (review rounds 1 and 2 on #431).
    const seed: GiftCardContent = { ...funded, code: 'JANE-SMITH', url: 'https://letterirl.com/g/JANE-SMITH', multiUse: true };
    const page = giftLetterPageSvg({ ...seed, newAccountsOnly: true }, 'Jane');
    expect(page.html).toContain('For new Letter IRL customers. Each person can use the code once, while it lasts.');
    const block = giftPostcardBlockSvg({ ...seed, newAccountsOnly: true }, 'Jane');
    // The strip trades "while it lasts" for the new-customers line, so it
    // stays at two lines of fine print.
    expect(block.html).toContain('New customers only. One use per person.<');
    expect(block.html).not.toContain('while it lasts');
    expect(giftLetterPageSvg(seed, 'Jane').html).not.toContain('new Letter IRL customers');
    expect(giftPostcardBlockSvg(seed, 'Jane').html).not.toContain('New customers only.');
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

  it('names no AI app, since the letter may have been written in any of them (#487)', () => {
    for (const card of [funded, unfunded]) {
      for (const fragment of [giftLetterPageSvg(card, 'Sarah'), giftPostcardBlockSvg(card, 'Sarah')]) {
        expect(fragment.html, card.state).not.toMatch(/ChatGPT|Claude|Codex/);
      }
    }
    expect(giftLetterPageSvg(unfunded, 'Sarah').html).toContain('a conversation with an AI assistant into a real letter');
    expect(giftLetterPageSvg(funded, 'Sarah').html).toContain('You write your letter with your AI assistant');
    expect(giftPostcardBlockSvg(unfunded, 'Sarah').html).toContain('A conversation with an AI assistant, printed and mailed.');
  });

  it('gives the HTML and our renderer the same words, from one source (#534)', () => {
    const escaped = (text: string) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    for (const card of [funded, unfunded, { ...funded, code: undefined, sample: true }]) {
      const copy = giftLetterPageCopy(card, 'Pat <Example> & Co');
      const { html } = giftLetterPageSvg(card, 'Pat <Example> & Co');
      const words = [copy.eyebrow, copy.title, copy.lede, ...copy.steps.map(step => step.text), ...(copy.fine ? [copy.fine] : [])];
      for (const text of words) expect(html, text).toContain(`>${escaped(text)}</`);
      expect(copy.qrUrl).toBe(card.url);
    }
    // Each step keeps its kind, which sets its size in both: in the HTML, by its class.
    expect(giftLetterPageCopy(funded, 'Pat').steps.map(step => step.kind)).toEqual(['plain', 'url', 'plain', 'code']);
    const { html } = giftLetterPageSvg(funded, 'Pat');
    expect(html).toContain('<p>Scan the code, or visit</p>');
    expect(html).toContain('<p class="gift-url">letterirl.com/g</p>');
    expect(html).toContain('<p class="gift-code">K7M2-QX9A</p>');
    expect(giftLetterPageCopy(unfunded, 'Pat').steps.map(step => step.kind)).toEqual(['plain', 'url']);
    expect(giftLetterPageCopy(unfunded, 'Pat').fine).toBeUndefined();
  });

  it("gives the postcard's legacy strip and our renderer the same words, from one source (#534)", () => {
    const escaped = (text: string) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const seed: GiftCardContent = { ...funded, code: 'PRESS2026', multiUse: true, newAccountsOnly: true };
    for (const card of [funded, unfunded, { ...funded, code: undefined, sample: true }, seed]) {
      const copy = giftPostcardStripCopy(card, 'Pat <Example> & Co');
      const { html } = giftPostcardBlockSvg(card, 'Pat <Example> & Co');
      const words = [copy.lead, ...copy.lines.map(line => line.text)];
      // Each in the legacy strip, in the same order.
      const at = words.map(text => html.indexOf(escaped(text)));
      for (const [index, text] of words.entries()) expect(at[index], text).toBeGreaterThan(-1);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(html).toContain(`<strong>${escaped(copy.lead)}</strong>`);
      expect(copy.qrUrl).toBe(card.url);
    }
    // The code keeps its kind, which sets its size in both: in the HTML, by its class.
    expect(giftPostcardStripCopy(funded, 'Pat').lines).toEqual([
      { text: 'a letter of your own, printed and mailed free. Scan, or visit letterirl.com/g and enter', kind: 'plain' },
      { text: 'K7M2-QX9A', kind: 'code' },
      { text: 'Redeem by December 16, 2026. One use.', kind: 'plain' }
    ]);
    expect(giftPostcardBlockSvg(funded, 'Pat').html).toContain('<span class="gift-block-code">K7M2-QX9A</span>');
    expect(giftPostcardStripCopy(unfunded, 'Pat')).toEqual({
      lead: 'Sent with Letter IRL',
      lines: [
        { text: 'A conversation with an AI assistant, printed and mailed.', kind: 'plain' },
        { text: 'letterirl.com', kind: 'plain' }
      ],
      qrUrl: 'https://letterirl.com'
    });
    expect(giftPostcardStripCopy({ ...funded, code: undefined, sample: true }, 'Pat').lines[1].text).toBe('••••-••••');
    expect(giftPostcardStripCopy(seed, 'Pat').lines.slice(1)).toEqual([
      { text: 'PRESS2026', kind: 'code' },
      { text: 'Redeem by December 16, 2026. New customers only. One use per person.', kind: 'plain' }
    ]);
    // A card with no date prints none.
    expect(giftPostcardStripCopy({ ...funded, redeemBy: undefined }, 'Pat').lines[2].text).toBe('One use.');
  });

  it('measures the strip against the date that prints longest', () => {
    // Every day of a year, as the strip prints it: none is wider than LONGEST_REDEEM_BY's.
    const font = loadFont('Tinos-Regular');
    const width = (redeemBy: string) => shape(font, giftPostcardStripCopy({ ...funded, redeemBy }, 'Pat').lines[2].text).advanceWidth;
    const longest = width(LONGEST_REDEEM_BY);
    expect(giftPostcardStripCopy({ ...funded, redeemBy: LONGEST_REDEEM_BY }, 'Pat').lines[2].text).toBe('Redeem by September 30, 2026. One use.');
    let widest = 0;
    for (let day = Date.UTC(2027, 0, 1); day < Date.UTC(2028, 0, 1); day += 24 * 60 * 60 * 1000) {
      widest = Math.max(widest, width(new Date(day).toISOString().slice(0, 10)));
    }
    expect(widest).toBeLessThanOrEqual(longest);
    expect(width('2026-05-01')).toBeLessThan(longest);
  });

  it('names the sender as given, trimmed, and someone when there is no name', () => {
    expect(giftPostcardStripCopy(funded, '  Pat Example ').lead).toBe('A gift from Pat Example:');
    expect(giftPostcardStripCopy(funded, '   ').lead).toBe('A gift from Someone:');
    expect(giftLetterPageCopy(funded, '  Pat Example ').lede).toMatch(/^Pat Example sent this letter/);
    expect(giftLetterPageCopy(funded, '   ').lede).toMatch(/^Someone sent this letter/);
    expect(giftLetterPageCopy(unfunded, '').lede).toMatch(/^Someone wrote it/);
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

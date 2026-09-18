import qrcode from 'qrcode-generator';
import sharp from 'sharp';

/**
 * The printed gift card (docs/gift-letters.md): an extra page on a letter, or
 * a block on the left half of a postcard back.
 *
 * One renderer for print and preview. The preview renderers in previewService
 * and quoteAndPreviewPostcard are otherwise separate from the print HTML in
 * PostGridProvider, and a card drawn twice would drift into a preview that
 * shows something other than what prints.
 *
 * The QR is drawn here from the code at render time. It is never stored as an
 * image on the draft: duplicateMailService fingerprints mail by the MD5 of the
 * image columns, so a per-letter QR there would make every letter unique and
 * defeat the #412 guard, and an image layout switches on colour printing.
 */

export type GiftCardState = 'funded' | 'unfunded';

/** What a sent letter records about its card, as letters.content.giftCard. */
export interface GiftCardContent {
  state: GiftCardState;
  /** The code on a funded card: a chain code, or a seed campaign's own code. */
  code?: string;
  /** What the QR encodes. */
  url: string;
  /** The address printed for people who type, without the scheme. */
  displayUrl: string;
  /** YYYY-MM-DD. */
  redeemBy?: string;
  /** Preview only: draw a placeholder where the recipient's code will print. */
  sample?: boolean;
}

export type GiftQrFormat = 'svg' | 'png';

/** ISO/IEC 18004 asks for a quiet zone of four modules. */
const QUIET_ZONE_MODULES = 4;
/** Q recovers about 25% of the symbol: enough for a crease or a scuff. */
const ERROR_CORRECTION = 'Q' as const;

const LETTER_QR_INCHES = 1.4;
const POSTCARD_QR_INCHES = 0.95;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function matrix(text: string) {
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(text, 'Byte');
  qr.make();
  return qr;
}

/**
 * The QR as inline SVG: one <rect> per horizontal run of dark modules, on a
 * white ground that includes the quiet zone. Rectangles rather than a path
 * because they are the most conservative thing an HTML-to-PDF renderer can be
 * handed; crispEdges stops anti-aliasing from blurring module edges.
 */
export function qrSvg(text: string, sizeInches: number): string {
  const qr = matrix(text);
  const count = qr.getModuleCount();
  const extent = count + QUIET_ZONE_MODULES * 2;
  const rects: string[] = [];
  for (let row = 0; row < count; row += 1) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < count && qr.isDark(row, col)) col += 1;
      rects.push(
        `<rect x="${start + QUIET_ZONE_MODULES}" y="${row + QUIET_ZONE_MODULES}" width="${col - start}" height="1"/>`
      );
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" ` +
    `width="${sizeInches}in" height="${sizeInches}in" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${extent}" height="${extent}" fill="#fff"/>` +
    `<g fill="#000">${rects.join('')}</g></svg>`
  );
}

/**
 * The same symbol as a PNG data URI, for LETTER_IRL_GIFT_QR_FORMAT=png: the
 * fallback if a test print shows PostGrid's renderer mishandling inline SVG.
 * Rasterised well above print resolution so the printer never interpolates.
 */
export async function qrPngDataUri(text: string, pixels = 600): Promise<string> {
  const svg = qrSvg(text, 1).replace(/width="1in" height="1in"/, `width="${pixels}" height="${pixels}"`);
  const png = await sharp(Buffer.from(svg)).png({ palette: true }).toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

export async function qrMarkup(
  text: string,
  sizeInches: number,
  format: GiftQrFormat = 'svg'
): Promise<string> {
  if (format === 'png') {
    const uri = await qrPngDataUri(text);
    return `<img src="${uri}" alt="QR code" style="width:${sizeInches}in;height:${sizeInches}in;display:block">`;
  }
  return qrSvg(text, sizeInches);
}

function printedCode(card: GiftCardContent): string {
  if (card.sample || !card.code) return '••••-••••';
  // Chain codes read in two groups of four. A seed campaign's code is a word
  // the operator chose, printed as chosen.
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(card.code)
    ? `${card.code.slice(0, 4)}-${card.code.slice(4)}`
    : card.code;
}

function redeemByText(card: GiftCardContent): string {
  if (!card.redeemBy) return '';
  const date = new Date(`${card.redeemBy}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const formatted = date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
  return `Redeem by ${formatted}. `;
}

export interface CardFragment {
  /**
   * Goes in <head>. Selectors are prefixed gift- so they cannot restyle the
   * letter; the one exception is the postcard block's .message-area rule.
   */
  css: string;
  html: string;
}

export const GIFT_LETTER_PAGE_CSS = `
    .gift-page { break-before: page; page-break-before: always; break-inside: avoid;
      padding-top: 1in; font-family: 'Georgia', 'Times New Roman', serif; color: #1f1a15; }
    .gift-card { border: 1.5pt solid #1f1a15; border-radius: 12pt; padding: 0.45in 0.5in;
      max-width: 6.5in; box-sizing: border-box; }
    .gift-eyebrow { font-size: 10pt; letter-spacing: 0.12em; text-transform: uppercase; margin: 0 0 8pt; }
    .gift-title { font-size: 22pt; font-weight: normal; line-height: 1.2; margin: 0 0 12pt; }
    .gift-lede { font-size: 12.5pt; line-height: 1.5; margin: 0 0 20pt; }
    .gift-claim { display: flex; align-items: center; gap: 0.35in; margin: 0 0 18pt; }
    .gift-qr { flex: 0 0 auto; line-height: 0; }
    .gift-steps p { margin: 0 0 4pt; font-size: 12pt; line-height: 1.4; }
    .gift-url { font-family: 'Courier New', monospace; font-size: 13pt; }
    .gift-code { font-family: 'Courier New', monospace; font-size: 24pt; font-weight: bold;
      letter-spacing: 0.08em; margin-top: 6pt !important; }
    .gift-fine { font-size: 9.5pt; line-height: 1.45; margin: 0; }`;

/**
 * The letter's extra page. A page break of its own, then a card in the upper
 * half of the sheet: PostGrid prints its integrity QR and sequence ids in the
 * bottom-left corner of letter pages, and the card must stay clear of them.
 * The padding sets the top margin because nothing guarantees a page margin on
 * page two: the letter body's 3.5in top margin exists for page one's address
 * window and applies only there.
 */
export function renderGiftCardLetterPage(
  card: GiftCardContent,
  senderName: string,
  qr: string
): CardFragment {
  const sender = escapeHtml(senderName.trim() || 'Someone');
  if (card.state === 'unfunded') {
    return {
      css: GIFT_LETTER_PAGE_CSS,
      html: `
  <section class="gift-page">
    <div class="gift-card">
      <p class="gift-eyebrow">Sent with Letter IRL</p>
      <h1 class="gift-title">This letter began as a conversation</h1>
      <p class="gift-lede">${sender} wrote it with Letter IRL, which turns a conversation in ChatGPT into a real letter, printed and mailed.</p>
      <div class="gift-claim">
        <div class="gift-qr">${qr}</div>
        <div class="gift-steps">
          <p>See how it works at</p>
          <p class="gift-url">${escapeHtml(card.displayUrl)}</p>
        </div>
      </div>
    </div>
  </section>`
    };
  }
  return {
    css: GIFT_LETTER_PAGE_CSS,
    html: `
  <section class="gift-page">
    <div class="gift-card">
      <p class="gift-eyebrow">A gift inside this letter</p>
      <h1 class="gift-title">A letter for you to send</h1>
      <p class="gift-lede">${sender} sent this letter with Letter IRL and included one more: a letter of your own, printed and mailed for you at no cost.</p>
      <div class="gift-claim">
        <div class="gift-qr">${qr}</div>
        <div class="gift-steps">
          <p>Scan the code, or visit</p>
          <p class="gift-url">${escapeHtml(card.displayUrl)}</p>
          <p>and enter</p>
          <p class="gift-code">${escapeHtml(printedCode(card))}</p>
        </div>
      </div>
      <p class="gift-fine">${escapeHtml(redeemByText(card))}The code works once. You write your letter with Letter IRL in ChatGPT, and we print and mail it.</p>
    </div>
  </section>`
  };
}

/**
 * The first rule stacks the message and the card in the message half. It
 * overrides the postcard back's own .message-area row layout, and lives here so
 * that a postcard without a card renders exactly as it did before.
 */
export const GIFT_POSTCARD_BLOCK_CSS = `
    .message-area { flex-direction: column; justify-content: space-between; align-items: stretch; }
    .gift-block { display: flex; align-items: center; gap: 0.18in; border-top: 1pt solid #b9ad99;
      padding-top: 0.14in; font-family: 'Georgia', serif; color: #1f1a15; }
    .gift-block-qr { flex: 0 0 auto; line-height: 0; }
    .gift-block-text { font-size: 9pt; line-height: 1.35; }
    .gift-block-text strong { font-size: 10pt; }
    .gift-block-code { font-family: 'Courier New', monospace; font-size: 12pt; font-weight: bold;
      letter-spacing: 0.06em; }`;

/** The postcard's version: a strip across the bottom of the message half. */
export function renderGiftCardPostcardBlock(
  card: GiftCardContent,
  senderName: string,
  qr: string
): CardFragment {
  const sender = escapeHtml(senderName.trim() || 'Someone');
  if (card.state === 'unfunded') {
    return {
      css: GIFT_POSTCARD_BLOCK_CSS,
      html: `
      <div class="gift-block">
        <div class="gift-block-qr">${qr}</div>
        <div class="gift-block-text"><strong>Sent with Letter IRL</strong><br>A conversation in ChatGPT, printed and mailed.<br>${escapeHtml(card.displayUrl)}</div>
      </div>`
    };
  }
  return {
    css: GIFT_POSTCARD_BLOCK_CSS,
    html: `
      <div class="gift-block">
        <div class="gift-block-qr">${qr}</div>
        <div class="gift-block-text"><strong>A gift from ${sender}:</strong> a letter of your own, printed and mailed free. Scan, or visit ${escapeHtml(card.displayUrl)} and enter<br><span class="gift-block-code">${escapeHtml(printedCode(card))}</span><br>${escapeHtml(redeemByText(card))}One use.</div>
      </div>`
  };
}

export async function buildGiftLetterPage(
  card: GiftCardContent,
  senderName: string,
  format: GiftQrFormat = 'svg'
): Promise<CardFragment> {
  return renderGiftCardLetterPage(card, senderName, await qrMarkup(card.url, LETTER_QR_INCHES, format));
}

export async function buildGiftPostcardBlock(
  card: GiftCardContent,
  senderName: string,
  format: GiftQrFormat = 'svg'
): Promise<CardFragment> {
  return renderGiftCardPostcardBlock(card, senderName, await qrMarkup(card.url, POSTCARD_QR_INCHES, format));
}

/** Synchronous SVG versions for the preview renderers, which are synchronous. */
export function giftLetterPageSvg(card: GiftCardContent, senderName: string): CardFragment {
  return renderGiftCardLetterPage(card, senderName, qrSvg(card.url, LETTER_QR_INCHES));
}

export function giftPostcardBlockSvg(card: GiftCardContent, senderName: string): CardFragment {
  return renderGiftCardPostcardBlock(card, senderName, qrSvg(card.url, POSTCARD_QR_INCHES));
}

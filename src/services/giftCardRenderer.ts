import sharp from 'sharp';
import { QUIET_ZONE_MODULES, qrMatrix, qrRuns } from '../render/qr.js';
import type { GiftPageCopy } from '../render/giftPage.js';
import type { GiftStripCopy } from '../render/postcard.js';

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
  /**
   * A seed campaign's code: shared on purpose (a press or influencer letter is
   * photographed), so many people may claim it, one claim each, up to the
   * campaign's cap. The card must not tell them it works once.
   */
  multiUse?: boolean;
  /**
   * A seed campaign limited to new accounts (requires_new_user). The card says
   * so: otherwise an existing customer who finds a shared letter is promised a
   * claim the redeem path refuses.
   */
  newAccountsOnly?: boolean;
  /** Preview only: draw a placeholder where the recipient's code will print. */
  sample?: boolean;
}

export type GiftQrFormat = 'svg' | 'png';

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

/**
 * The QR as inline SVG: one <rect> per horizontal run of dark modules, on a
 * white ground that includes the quiet zone. Rectangles rather than a path
 * because they are the most conservative thing an HTML-to-PDF renderer can be
 * handed; crispEdges stops anti-aliasing from blurring module edges.
 */
export function qrSvg(text: string, sizeInches: number): string {
  // The symbol and its runs come from src/render/qr.ts, which our own
  // renderer draws the gift page's QR from too (#534).
  const matrix = qrMatrix(text);
  const extent = matrix.count + QUIET_ZONE_MODULES * 2;
  const rects = qrRuns(matrix).map(run => `<rect x="${run.x}" y="${run.y}" width="${run.width}" height="1"/>`);
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

/** How many times the code works, in the letter page's and the strip's words. */
function usesText(card: GiftCardContent, length: 'letter' | 'postcard'): string {
  if (card.multiUse) {
    // "Customers", not "accounts": the redeem rule refuses anyone with a
    // purchase or spend on record (credit_transactions), however new the
    // account, and admits an old account that never had one.
    if (length === 'letter') {
      return `${card.newAccountsOnly ? 'For new Letter IRL customers. ' : ''}Each person can use the code once, while it lasts.`;
    }
    // The strip is about 40 characters wide: the new-customers line replaces
    // "while it lasts" rather than adding a third line of fine print.
    return card.newAccountsOnly ? 'New customers only. One use per person.' : 'One use per person, while it lasts.';
  }
  return length === 'letter' ? 'The code works once.' : 'One use.';
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
 * The letter page's words: one source for the legacy HTML below and for our
 * own renderer (src/render/giftPage.ts), so the two cannot drift (#534).
 * Plain text; each consumer escapes or draws it.
 */
export function giftLetterPageCopy(card: GiftCardContent, senderName: string): GiftPageCopy {
  const sender = senderName.trim() || 'Someone';
  if (card.state === 'unfunded') {
    return {
      eyebrow: 'Sent with Letter IRL',
      title: 'This letter began as a conversation',
      lede: `${sender} wrote it with Letter IRL, which turns a conversation with an AI assistant into a real letter, printed and mailed.`,
      steps: [
        { text: 'See how it works at', kind: 'plain' },
        { text: card.displayUrl, kind: 'url' }
      ],
      qrUrl: card.url
    };
  }
  return {
    eyebrow: 'A gift inside this letter',
    title: 'A letter for you to send',
    lede: `${sender} sent this letter with Letter IRL and included one more: a letter of your own, printed and mailed for you at no cost.`,
    steps: [
      { text: 'Scan the code, or visit', kind: 'plain' },
      { text: card.displayUrl, kind: 'url' },
      { text: 'and enter', kind: 'plain' },
      { text: printedCode(card), kind: 'code' }
    ],
    fine: `${redeemByText(card)}${usesText(card, 'letter')} You write your letter with your AI assistant, and we print and mail it.`,
    qrUrl: card.url
  };
}

const STEP_CLASS: Record<GiftPageCopy['steps'][number]['kind'], string> = {
  plain: '',
  url: ' class="gift-url"',
  code: ' class="gift-code"'
};

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
  const copy = giftLetterPageCopy(card, senderName);
  const steps = copy.steps
    .map(step => `\n          <p${STEP_CLASS[step.kind]}>${escapeHtml(step.text)}</p>`)
    .join('');
  const fine = copy.fine === undefined ? '' : `\n      <p class="gift-fine">${escapeHtml(copy.fine)}</p>`;
  return {
    css: GIFT_LETTER_PAGE_CSS,
    html: `
  <section class="gift-page">
    <div class="gift-card">
      <p class="gift-eyebrow">${escapeHtml(copy.eyebrow)}</p>
      <h1 class="gift-title">${escapeHtml(copy.title)}</h1>
      <p class="gift-lede">${escapeHtml(copy.lede)}</p>
      <div class="gift-claim">
        <div class="gift-qr">${qr}</div>
        <div class="gift-steps">${steps}
        </div>
      </div>${fine}
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

/**
 * The strip's words for our renderer (#534): the same words as the legacy
 * strip below, which a test holds them to. The lead takes a line of its own
 * in the larger size, where the legacy strip runs it into the sentence.
 */
export function giftPostcardStripCopy(card: GiftCardContent, senderName: string): GiftStripCopy {
  const sender = senderName.trim() || 'Someone';
  if (card.state === 'unfunded') {
    return {
      lead: 'Sent with Letter IRL',
      lines: [
        { text: 'A conversation with an AI assistant, printed and mailed.', kind: 'plain' },
        { text: card.displayUrl, kind: 'plain' }
      ],
      qrUrl: card.url
    };
  }
  const fine = `${redeemByText(card)}${usesText(card, 'postcard')}`;
  return {
    lead: `A gift from ${sender}:`,
    lines: [
      { text: `a letter of your own, printed and mailed free. Scan, or visit ${card.displayUrl} and enter`, kind: 'plain' },
      { text: printedCode(card), kind: 'code' },
      { text: fine, kind: 'plain' }
    ],
    qrUrl: card.url
  };
}

/**
 * The redeem-by date that prints longest ("September 30, 2026"): a preview
 * checks its strip fits with it, because the send fixes the real date.
 */
export const LONGEST_REDEEM_BY = '2026-09-30';

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
        <div class="gift-block-text"><strong>Sent with Letter IRL</strong><br>A conversation with an AI assistant, printed and mailed.<br>${escapeHtml(card.displayUrl)}</div>
      </div>`
    };
  }
  return {
    css: GIFT_POSTCARD_BLOCK_CSS,
    html: `
      <div class="gift-block">
        <div class="gift-block-qr">${qr}</div>
        <div class="gift-block-text"><strong>A gift from ${sender}:</strong> a letter of your own, printed and mailed free. Scan, or visit ${escapeHtml(card.displayUrl)} and enter<br><span class="gift-block-code">${escapeHtml(printedCode(card))}</span><br>${escapeHtml(redeemByText(card))}${usesText(card, 'postcard')}</div>
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

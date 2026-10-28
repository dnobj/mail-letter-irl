/**
 * What a letter or a postcard prints as, drawn by our renderer (#534): the
 * layout the print draws, and the PDF made from it. One place, so that the
 * print, and the send that records what the print will draw for mail held
 * for its date (#697), lay a letter out the same way by construction.
 *
 * No I/O but the renderer's own: the font files, read once from disk. Every
 * failure is a RenderRefusal, raised before any request leaves for a provider.
 */

import type { HeldPrint, LetterParams, PostcardParams, PostcardSize } from './providers/types.js';
import { giftLetterPageCopy, giftPostcardStripCopy } from './giftCardRenderer.js';
import {
  layoutGiftPage,
  layoutLetter,
  layoutPostcard,
  MAX_LETTER_PAGES,
  POSTCARD_FRONT_RENDERER_VERSION,
  postcardFrontOf,
  PostcardFrontOverflow,
  readImageDataUri,
  renderPdf,
  RENDERER_VERSION,
  rendererVersionFor,
  STATIONERY_RENDERER_VERSION,
  SIGNATURE_RENDERER_VERSION,
  stationeryOf,
  type Layout,
  type PostcardFront,
  type Stationery
} from '../render/index.js';
import { fingerprintScheme, isLayoutFingerprint, LAYOUT_FINGERPRINT_SCHEME, layoutFingerprint } from '../render/fingerprint.js';

/**
 * Our own refusal to draw a letter or postcard, before anything is sent to
 * PostGrid (#534). It is held like every failure that is not an explicit provider
 * rejection (a retry after an ambiguous first attempt must never refund mail
 * that may have printed), but it is logged with its reason and held with the
 * class `render_refused`, so an operator can see that no request left and
 * resolve it with a retry once a build that can print it is deployed.
 */
export class RenderRefusal extends Error {
  constructor(
    readonly reason: 'unknown_version' | 'image' | 'overflow' | 'size' | 'render' | 'pages' | 'layout_changed',
    message: string
  ) {
    super(message);
    this.name = 'RenderRefusal';
  }
}

/** A layout as the print draws it, with the renderer version its PDF names. */
export interface PrintLayout {
  layout: Layout;
  rendererVersion: string;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The pages a letter prints on (#586): one unless its content says more. Only
 * our renderer lays out more than one, and never beside a gift card, which
 * takes a sheet of its own. Anything else is refused before any request.
 */
export function letterPages(params: LetterParams, usePdf: boolean): number {
  const pages = params.pages ?? 1;
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_LETTER_PAGES) {
    throw new RenderRefusal('pages', `The letter's page count is not a whole number from 1 to ${MAX_LETTER_PAGES}.`);
  }
  if (pages > 1 && !usePdf) {
    throw new RenderRefusal('pages', 'A letter of more than one page prints only from our renderer, not the legacy HTML.');
  }
  if (pages > 1 && params.giftCard) {
    throw new RenderRefusal('pages', 'A gift letter prints on one page, its card on a sheet of its own.');
  }
  return pages;
}

/**
 * The letter laid out as it was previewed (src/render, #534). The preview
 * refused a letter longer than the page, so an overflow here means the text
 * or the renderer changed since: a refusal, never a clipped letter.
 */
export function letterPrintLayout(params: LetterParams, pages: number): PrintLayout {
  const layoutType = params.layoutType ?? 'text_only';
  const imageData = layoutType === 'header_image'
    ? params.headerImageData
    : layoutType === 'inline_image' ? params.inlineImageData : undefined;
  let image;
  try {
    image = imageData ? readImageDataUri(imageData) : undefined;
  } catch (error) {
    throw new RenderRefusal('image', `The letter's image could not be read: ${reason(error)}`);
  }
  // A letter drawn in stationery (#563) prints in it: pdf-2, or pdf-4 with a
  // theme beside its signature (#608). One whose stored theme this build
  // cannot read is refused, never printed as Classic.
  let stationery: Stationery | undefined;
  const signed = params.rendererVersion === SIGNATURE_RENDERER_VERSION;
  if (params.rendererVersion === STATIONERY_RENDERER_VERSION || (signed && params.stationery != null)) {
    const stored = stationeryOf(params.stationery);
    if (!stored) {
      throw new RenderRefusal('render', 'The letter was drawn in stationery this build cannot read.');
    }
    stationery = stored;
  }
  // A letter drawn with a signature (#608) prints with it, under the sign-off's
  // first line; one that no longer has it is held, never printed unsigned.
  let signature: { image: ReturnType<typeof readImageDataUri>; closingParagraph: number } | undefined;
  if (signed) {
    if (!params.signature) {
      throw new RenderRefusal('render', 'The letter was drawn with a signature it no longer has.');
    }
    try {
      signature = { image: readImageDataUri(params.signature.image), closingParagraph: params.signature.closingParagraph };
    } catch (error) {
      throw new RenderRefusal('image', `The letter's signature could not be read: ${reason(error)}`);
    }
  }
  let layout;
  try {
    // Laid out as a preview lays it out, on up to the most pages (#586), so
    // the letter prints as it was drawn by construction: a page count of its
    // own would treat a last line of invisible characters otherwise (#589
    // review round 3). A letter that fits one page is laid out as ever.
    layout = layoutLetter({ text: params.message, layoutType, image, stationery, signature }, { maxPages: MAX_LETTER_PAGES });
  } catch (error) {
    throw new RenderRefusal('render', `The letter could not be laid out: ${reason(error)}`);
  }
  if (layout.overflowLines > 0) {
    throw new RenderRefusal('overflow', `The letter runs ${layout.overflowLines} line(s) past ${MAX_LETTER_PAGES} pages.`);
  }
  // On exactly the pages it was previewed and priced on (#586): one that now
  // lays out on more would print pages nobody paid for, and on fewer was sold
  // for pages it would not fill. Its layout changed since the preview, as an
  // overflow's does, so it is held as one: the reason alone tells an operator
  // to fix the renderer and retry (#589 review round 1), where `pages` means a
  // count no writer stores.
  if (layout.pages.length !== pages) {
    throw new RenderRefusal('overflow', `The letter lays out on ${layout.pages.length} page(s), not the ${pages} it was previewed on.`);
  }
  // A gift send's card, with the code the send minted, is the second page.
  if (params.giftCard) {
    try {
      layout.pages.push(layoutGiftPage(giftLetterPageCopy(params.giftCard, params.senderName || '')));
    } catch (error) {
      throw new RenderRefusal('render', `The gift card could not be laid out: ${reason(error)}`);
    }
  }
  return { layout, rendererVersion: rendererVersionFor(stationery, signature !== undefined) };
}

/**
 * The postcard laid out as it was previewed (src/render, #534 Phase 4), at its
 * size (#594): the front image, the back's message and a gift send's card,
 * never the addresses, which PostGrid stamps.
 */
export function postcardPrintLayout(params: PostcardParams, size: PostcardSize): PrintLayout {
  // A gift card prints only on a 6x9 (#579): refused before it is drawn.
  if (params.giftCard && size !== '6x9') {
    throw new RenderRefusal('size', `A gift postcard is 6x9, not ${size}.`);
  }
  // A front other than full bleed (#594) prints as it was drawn. One whose
  // stored front this build cannot read is refused, never printed full bleed.
  let front: PostcardFront | undefined;
  if (params.rendererVersion === POSTCARD_FRONT_RENDERER_VERSION) {
    const stored = postcardFrontOf(params.front);
    if (!stored) {
      throw new RenderRefusal('render', 'The postcard was drawn with a front this build cannot read.');
    }
    front = stored;
  }
  let image;
  try {
    image = readImageDataUri(params.frontImageBase64);
  } catch (error) {
    throw new RenderRefusal('image', `The postcard's image could not be read: ${reason(error)}`);
  }
  let layout;
  try {
    // A gift send's card, with the code the send minted. A strip its words
    // overflow (GiftStripOverflow) is held here.
    const strip = params.giftCard ? giftPostcardStripCopy(params.giftCard, params.senderName || '') : undefined;
    layout = layoutPostcard({ message: params.backMessage, image, strip, size, ...front });
  } catch (error) {
    // A caption or place that no longer fits was measured to fit when it
    // was previewed, under the same version: the layout changed, as an
    // overflow of the message means.
    if (error instanceof PostcardFrontOverflow) throw new RenderRefusal('overflow', error.message);
    throw new RenderRefusal('render', `The postcard could not be laid out: ${reason(error)}`);
  }
  if (layout.overflowLines > 0) {
    throw new RenderRefusal('overflow', `The postcard's message runs ${layout.overflowLines} line(s) past its room on the back.`);
  }
  return { layout, rendererVersion: front ? POSTCARD_FRONT_RENDERER_VERSION : RENDERER_VERSION };
}

/**
 * Held mail lays out as the send recorded it (#697), or is refused: a
 * renderer, font or layout rule deployed while it waited would otherwise print
 * line breaks nobody saw. A fingerprint of a scheme this build does not make
 * (a newer deploy's, then rolled back) cannot be compared, so it is refused
 * too, as a renderer version this build cannot draw is. Mail with no
 * fingerprint, as all mail not held has, prints as it lays out.
 */
export function assertLayoutAsRecorded(print: PrintLayout, recorded: string | undefined, kind: 'letter' | 'postcard'): void {
  if (recorded == null) return;
  if (!isLayoutFingerprint(recorded) || fingerprintScheme(recorded) !== LAYOUT_FINGERPRINT_SCHEME) {
    throw new RenderRefusal('unknown_version', `This build cannot compare the ${kind}'s recorded layout.`);
  }
  if (layoutFingerprint(print.layout, print.rendererVersion) !== recorded) {
    throw new RenderRefusal('layout_changed', `The ${kind} lays out differently from when it was sent.`);
  }
}

/**
 * The PDF a print uploads (#697): the one stored for held mail at its send,
 * as it is, or else the mail laid out again (`lay`, whose refusals stand),
 * checked against the fingerprint the send recorded, and drawn.
 */
export async function printPdfFor(
  lay: () => PrintLayout,
  held: HeldPrint | undefined,
  kind: 'letter' | 'postcard'
): Promise<Buffer> {
  if (held?.pdf) return held.pdf;
  const print = lay();
  assertLayoutAsRecorded(print, held?.layoutFingerprint, kind);
  return drawPrintPdf(print, kind);
}

/** The PDF of a print layout. A failure is a RenderRefusal, before any request. */
export async function drawPrintPdf(print: PrintLayout, kind: 'letter' | 'postcard'): Promise<Buffer> {
  try {
    return await renderPdf(print.layout, print.rendererVersion);
  } catch (error) {
    throw new RenderRefusal('render', `The ${kind} could not be drawn: ${reason(error)}`);
  }
}

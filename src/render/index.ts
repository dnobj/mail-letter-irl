/**
 * Our own print renderer (#534): one layout drives both the PDF sent to the
 * printer and the preview the person sees. Pure functions, no I/O beyond
 * reading the bundled fonts. Letters previewed with it (LETTER_IRL_PRINT_RENDERER,
 * src/config/printRenderer.ts) record RENDERER_VERSION and print from its PDF.
 */
export { drawsGrapheme, drawsGraphemeIn, inFace, layoutLetter, pageFit, wrapParagraph } from './layout.js';
export type { ImageBox, Layout, LayoutOptions, LayoutPage, LetterContent, PageFit, PathItem, TextRun } from './layout.js';
export {
  bodyFace, HEADLINE_LINES, headlineSize, slotText, STATIONERY_CORNER, STATIONERY_SLOT_MAX_LENGTH, STATIONERY_THEMES,
  stationeryOf, StationeryOverflow
} from './stationery.js';
export type { Face, Stationery, StationeryTheme } from './stationery.js';
export {
  POSTCARD_FRONT_RENDERER_VERSION, PRINTABLE_RENDERER_VERSIONS, renderPdf, RENDERER_VERSION, rendererVersionFor, SIGNATURE_RENDERER_VERSION,
  STATIONERY_RENDERER_VERSION
} from './pdf.js';
export { GiftPageOverflow, layoutGiftPage } from './giftPage.js';
export type { GiftPageCopy } from './giftPage.js';
export {
  GiftStripOverflow, layoutPostcard, layoutPostcardBack, POSTCARD_FRONT_TEXT_MAX_LENGTH, postcardFrontOf, PostcardFrontOverflow
} from './postcard.js';
export { CONTINUATION_TOP, MAX_LETTER_PAGES, POSTCARD_GEOMETRY, POSTCARD_STAMP, SIGNATURE_LINES } from './geometry.js';
export type { PostcardGeometry, PostcardLayoutName, PostcardSizeName, StampGeometry } from './geometry.js';
export type { GiftStripCopy, PostcardContent, PostcardFront } from './postcard.js';
export { renderPreviewSvg } from './preview.js';
export type { PreviewOptions } from './preview.js';
export { readImage, readImageDataUri } from './images.js';
export type { RenderImage } from './images.js';
export { visualOrder } from './bidi.js';

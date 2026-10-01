/**
 * Our own print renderer (#534): one layout drives both the PDF sent to the
 * printer and the preview the person sees. Pure functions, no I/O beyond
 * reading the bundled fonts. Letters previewed with it (LETTER_IRL_PRINT_RENDERER,
 * src/config/printRenderer.ts) record RENDERER_VERSION and print from its PDF.
 */
export { drawsGrapheme, layoutLetter, wrapParagraph } from './layout.js';
export type { ImageBox, Layout, LayoutPage, LetterContent, TextRun } from './layout.js';
export { renderPdf, RENDERER_VERSION, PRINTABLE_RENDERER_VERSIONS } from './pdf.js';
export { GiftPageOverflow, layoutGiftPage } from './giftPage.js';
export type { GiftPageCopy } from './giftPage.js';
export { renderPreviewSvg } from './preview.js';
export type { PreviewOptions } from './preview.js';
export { readImage, readImageDataUri } from './images.js';
export type { RenderImage } from './images.js';
export { visualOrder } from './bidi.js';

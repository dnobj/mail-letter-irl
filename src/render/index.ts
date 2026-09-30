/**
 * Our own print renderer (#534): one layout drives both the PDF sent to the
 * printer and the preview the person sees. Pure functions, no I/O beyond
 * reading the bundled fonts. Not wired in yet: see #534 Phase 2.
 */
export { layoutLetter, wrapParagraph } from './layout.js';
export type { ImageBox, Layout, LayoutPage, LetterContent, TextRun } from './layout.js';
export { renderPdf, RENDERER_VERSION } from './pdf.js';
export { renderPreviewSvg } from './preview.js';
export { readImage, readImageDataUri } from './images.js';
export type { RenderImage } from './images.js';
export { missingCharacters } from './fonts.js';
export { visualOrder } from './bidi.js';

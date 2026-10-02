import { printRenderer } from './printRenderer.js';
import { isJitPurchaseEnabled, ROOM_TO_WRITE_FLAG } from './products.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';
import { MAX_LETTER_PAGES } from '../render/geometry.js';

/**
 * Room to write (#586): a letter previewed on more than one page.
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

/**
 * Whether the letter previews lay a letter out on up to three pages: the flag
 * is on (it also sells the two- and three-page Pay & Send prices, #578), our
 * renderer draws the page, and Pay & Send is on, since nothing else pays for a
 * letter of more than one page (#579). Off, every letter is one page, as
 * before. A letter already previewed on more pages still prints on them: the
 * send and the print read the draft's own page count, never this.
 */
export function isRoomToWriteOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled(ROOM_TO_WRITE_FLAG, env) && printRenderer(env) === 'pdf' && isJitPurchaseEnabled();
}

/** The most pages a preview lays a letter out on: three while room to write is offered, otherwise one. */
export function letterPageLimit(env: NodeJS.ProcessEnv = process.env): number {
  return isRoomToWriteOffered(env) ? MAX_LETTER_PAGES : 1;
}

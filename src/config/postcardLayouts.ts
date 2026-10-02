import { printRenderer } from './printRenderer.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * A postcard's front layouts (#594): the photo in a white border over its
 * caption, or Greetings from a place, besides full bleed.
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

export const POSTCARD_LAYOUTS_FLAG = 'LETTER_IRL_POSTCARD_LAYOUTS_ENABLED';

/**
 * Whether the postcard preview offers the border and greetings fronts: the
 * flag is on, and our renderer draws the postcard, since the legacy print
 * draws the photo alone. A layout costs nothing more, so it needs no Pay &
 * Send. Off, every front is full bleed, as before. A postcard already
 * previewed with a front still prints with it: the send and the print read
 * the draft's own front, never this.
 */
export function isPostcardLayoutsOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled(POSTCARD_LAYOUTS_FLAG, env) && printRenderer(env) === 'pdf';
}

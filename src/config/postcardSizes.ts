import { printRenderer } from './printRenderer.js';
import { isJitPurchaseEnabled, POSTCARD_SIZES_FLAG } from './products.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';
import type { PostcardSize } from '../services/types.js';

/**
 * The 4x6 and 11x6 postcards (#594).
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

/**
 * Whether the postcard preview offers the 4x6 and the 11x6 besides the 6x9:
 * the flag is on (it also sells their Pay & Send prices, #578), our renderer
 * draws the postcard, since the legacy back is a 9 x 6in page whatever the
 * card, and Pay & Send is on, since nothing else pays for either (#579). Off,
 * a postcard is a 6x9, as before. One already previewed at another size still
 * prints at it: the send and the print read the draft's own size, never this.
 */
export function isPostcardSizesOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled(POSTCARD_SIZES_FLAG, env) && printRenderer(env) === 'pdf' && isJitPurchaseEnabled(env);
}

/** The sizes a postcard preview takes: the three while the others are offered, otherwise the 6x9. */
export function offeredPostcardSizes(env: NodeJS.ProcessEnv = process.env): readonly PostcardSize[] {
  return isPostcardSizesOffered(env) ? ['6x9', '6x4', '6x11'] : ['6x9'];
}

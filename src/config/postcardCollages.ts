import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * Postcard collages (#616): two to four photos drawn as one front.
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

export const POSTCARD_COLLAGES_FLAG = 'LETTER_IRL_POSTCARD_COLLAGES_ENABLED';

/**
 * Whether the postcard preview takes `images` and `imageUrls`: the flag is
 * on. A collage is one JPEG at the postcard's size, stored and printed as a
 * single photo's crop is by either print path, and costs nothing more, so it
 * needs neither our renderer nor Pay & Send. Off, the preview is served
 * without them and refuses a stray one. A postcard already previewed as a
 * collage still prints: the send and the print read the draft's own picture,
 * never this.
 */
export function isPostcardCollagesOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled(POSTCARD_COLLAGES_FLAG, env);
}

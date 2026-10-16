import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * The envelope reveal (#576, docs/ui-widgets.md): a letter preview's card
 * opens the page from a window envelope, and folds it back in once the letter
 * is sent. Cards only: nothing prints differently.
 *
 * Read per call, never at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call.
 */

/** The letter previews' card-only _meta key that says the card may play the reveal. */
export const ENVELOPE_REVEAL_META = 'letterirl/envelopeReveal';

/** Off unless explicitly on: production waits for the owner's word (#576). */
export function isEnvelopeRevealEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', env);
}

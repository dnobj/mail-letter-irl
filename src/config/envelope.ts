import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * The envelope reveal (#576, docs/ui-widgets.md): a letter preview's card,
 * and the website's confirmation page (by GET /api/sends/:draftId), open the
 * page from a window envelope, and each shows it sealed after its own
 * successful Send or Schedule.
 * Nothing prints differently.
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

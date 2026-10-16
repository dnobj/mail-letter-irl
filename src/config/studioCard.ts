import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * The studio card (#580, docs/ui-widgets.md): a letter preview's card lays
 * itself out as a studio, the page beside Style, Words and Delivery tabs.
 * Cards only: every control in it is one the card already had, and nothing
 * prints or sends differently.
 *
 * Read per call, never at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call.
 */

/** The letter previews' card-only _meta key that says the card may lay itself out as a studio. */
export const STUDIO_CARD_META = 'letterirl/studioCard';

/** Off unless explicitly on: production waits for the owner's word (#580). */
export function isStudioCardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_STUDIO_CARD_ENABLED', env);
}

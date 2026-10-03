import { printRenderer } from './printRenderer.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * Signatures (#608, concept 3 in docs/letter-creator-vision.md): a picture of
 * the person's handwritten signature, saved once, which their letters print
 * under the closing.
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

/**
 * Off unless explicitly on: production waits for the owner's word, and the
 * privacy policy's wording for a saved signature (#608). While off, the tools
 * are not listed and refuse if called, and the REST routes answer 404.
 */
export function isSignaturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_SIGNATURES_ENABLED', env);
}

/**
 * Whether signatures are offered: the flag is on and our renderer draws
 * letters, since only it can draw a signature (LETTER_IRL_PRINT_RENDERER).
 */
export function isSignaturesOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSignaturesEnabled(env) && printRenderer(env) === 'pdf';
}

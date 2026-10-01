import { printRenderer } from './printRenderer.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * Stationery settings (#563, docs/letter-send-flow.md).
 *
 * Nothing here reads its environment at module load, for the reason given in
 * src/auth/betaAccess.ts: tests vary it per call, and a module-level constant
 * reads as live configuration when it is not.
 */

/**
 * Off unless explicitly on: production waits for the owner's word (#563).
 * While off, the letter previews neither offer nor accept a theme, and every
 * letter is Classic. A letter already previewed in a theme still prints in
 * it: the send and the print read the draft's own stationery, never this.
 */
export function isStationeryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_STATIONERY_ENABLED', env);
}

/**
 * Whether the letter previews offer stationery: the flag is on and our
 * renderer draws them, since only it draws a theme (LETTER_IRL_PRINT_RENDERER).
 */
export function isStationeryOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return isStationeryEnabled(env) && printRenderer(env) === 'pdf';
}

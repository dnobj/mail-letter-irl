import { isStationeryOffered } from './stationery.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * Saved stationery designs (#649, docs/letter-send-flow.md).
 *
 * Nothing here reads its environment at module load: tests vary it per call.
 */

/**
 * Off unless explicitly on: production waits for the owner's word (#649).
 * While off, no tool saves, lists or deletes a design, and the letter previews
 * and set_stationery neither offer nor accept one. A letter already previewed
 * in a design still prints in it: the send and the print read the draft's own
 * copy, never this.
 */
export function isCustomStationeryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return offUnlessExplicitlyEnabled('LETTER_IRL_CUSTOM_STATIONERY_ENABLED', env);
}

/** Whether designs are offered: the flag, and stationery offered, since a design is drawn as stationery is. */
export function isCustomStationeryOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCustomStationeryEnabled(env) && isStationeryOffered(env);
}

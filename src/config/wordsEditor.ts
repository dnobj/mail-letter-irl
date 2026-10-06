import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';
import { printRenderer } from './printRenderer.js';
import { letterPageLimit } from './roomToWrite.js';

/**
 * Whether a letter's words can be changed in place, on the card's Words tab and
 * with set_letter_words (#647): always while room to write is offered (#586),
 * and on its own, on one page, while LETTER_IRL_WORDS_EDITOR_ENABLED is on and
 * our renderer draws the page (only it can draw a letter again). Off unless
 * explicitly on: production waits for the owner's word.
 */
export function isWordsEditorOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  return letterPageLimit(env) > 1 || (offUnlessExplicitlyEnabled('LETTER_IRL_WORDS_EDITOR_ENABLED', env) && printRenderer(env) === 'pdf');
}

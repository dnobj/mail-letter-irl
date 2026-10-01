/**
 * A letter preview's stationery (#563): the `stationery`, `monogram` and
 * `headline` the three letter previews take, checked against what each theme
 * prints (src/render/stationery.ts), as the draft records it and the
 * preview's output says it.
 */

import type { ToolContext } from '../contracts/types.js';
import { isStationeryEnabled } from '../config/stationery.js';
import {
  drawsGrapheme,
  headlineSize,
  slotText,
  STATIONERY_SLOT_MAX_LENGTH,
  STATIONERY_THEMES,
  visualOrder,
  type Stationery,
  type StationeryTheme
} from '../render/index.js';
import { withoutInvisible } from '../render/bidi.js';
import { SCHEDULE_TIME_ZONE } from '../services/deliverySchedule.js';

/** The previews' three stationery arguments, as they arrive: unchecked. */
export interface StationeryInput {
  stationery?: unknown;
  monogram?: unknown;
  headline?: unknown;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clusters = (text: string): string[] => [...graphemes.segment(text)].map(({ segment }) => segment);

/** A letter, with any marks it carries: what a monogram is made of. */
const LETTER = /^\p{L}\p{M}*$/u;
const MONOGRAM_MAX_LETTERS = 3;

const THEME_LIST = `${STATIONERY_THEMES.slice(0, -1).join(', ')} or ${STATIONERY_THEMES[STATIONERY_THEMES.length - 1]}`;

const DATE_LINE = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULE_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric'
});

/**
 * The date line a themed letter prints: the day it was previewed on the New
 * York calendar, written out ("October 1, 2026"), as a letter is dated the
 * day it is written.
 */
export function dateLineFor(now: Date): string {
  return DATE_LINE.format(now);
}

/** A refusal the preview tools surface as the person's to fix, not a fault. */
function refusal(message: string, reason: string, context: ToolContext): Error {
  context.logger.warn(
    { correlationId: context.correlationId, event: 'quote.stationery_refused', reason },
    'A stationery choice was refused'
  );
  return Object.assign(new Error(message), { diagnosticClass: 'validation_error' });
}

/**
 * An optional text argument: trimmed, or undefined when absent or empty,
 * which models send for an optional field they leave unset.
 */
function optionalText(value: unknown, name: string, expected: string, context: ToolContext): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw refusal(`${name} must be ${expected}.`, `${name}_not_text`, context);
  const text = value.trim();
  return text === '' ? undefined : text;
}

/**
 * Titles and suffixes a name carries, which are no one's initials: "Dr. Pat
 * Rivera" and "Pat Rivera Jr." are both PR. Compared in lower case without
 * full stops ("M.D." is md).
 */
const NOT_INITIALS: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'rev', 'prof', 'sir', 'dame',
  'jr', 'sr', 'ii', 'iii', 'iv', 'md', 'phd', 'esq', 'dds'
]);

/**
 * The initials a Monogram letter prints: the `monogram` asked for, or the
 * initials of the return address's name. Asked for, spaces and full stops
 * are dropped ("J. M. S." is JMS) and what is left must be one to three
 * letters, as written. From the name, each word that starts with a letter
 * gives its first, in capitals, but a title or a suffix; past three, the
 * first two and the last, as a first, middle and last name would.
 */
function initialsFor(asked: string | undefined, senderName: string, context: ToolContext): string {
  if (asked !== undefined) {
    // Spaces and full stops go before the marks are clamped, so no letter
    // gathers the marks of two.
    const letters = clusters(slotText(asked.replace(/[\s.]/gu, '')));
    if (letters.length === 0 || letters.length > MONOGRAM_MAX_LETTERS || !letters.every(letter => LETTER.test(letter))) {
      throw refusal(
        'monogram must be one to three letters, such as "JMS". Leave it out to use the initials of the return address\'s name.',
        'monogram_not_initials',
        context
      );
    }
    return letters.join('');
  }
  // Words split at any space or comma, with characters that print nothing
  // gone first, so neither hides a word's first letter.
  const initials = withoutInvisible(slotText(senderName))
    .split(/[\s,]+/u)
    .filter(word => !NOT_INITIALS.has(word.replace(/\./g, '').toLowerCase()))
    .map(word => clusters(word)[0])
    .filter((first): first is string => first !== undefined && LETTER.test(first))
    .map(first => {
      // A capital that is two letters (German's sharp s is SS), or one the
      // font cannot draw, stays as written.
      const capital = first.toUpperCase();
      return clusters(capital).length === 1 && drawsGrapheme(capital) ? capital : first;
    });
  if (initials.length === 0) {
    throw refusal(
      'The monogram stationery prints initials, and the return address\'s name has none to use. ' +
        'Pass monogram with one to three letters, such as "JMS", or choose another stationery.',
      'monogram_no_initials',
      context
    );
  }
  return (initials.length > MONOGRAM_MAX_LETTERS ? [initials[0], initials[1], initials[initials.length - 1]] : initials).join('');
}

/**
 * Celebration's headline as it prints, or undefined when it prints nothing.
 * It holds at most STATIONERY_SLOT_MAX_LENGTH characters as stored, so what a
 * draft records reads back. It prints on one line, shrinking to fit the
 * body's width down to the smallest size it prints at (headlineSize);
 * longer, it is refused, saying how much of it fits. A headline holding a
 * character the font cannot draw is left to the printable check, which every
 * caller runs next and which names it: measured, its boxes would only say
 * "too long".
 */
function headlineFor(asked: string, context: ToolContext): string | undefined {
  const text = slotText(asked);
  if (visualOrder(text).trim() === '') return undefined;
  if (text.length > STATIONERY_SLOT_MAX_LENGTH) {
    throw refusal(
      `The headline is too long: it may hold at most ${STATIONERY_SLOT_MAX_LENGTH} characters. Shorten it, or leave headline out.`,
      'headline_too_long',
      context
    );
  }
  const characters = clusters(text);
  if (headlineSize(text) !== null || !characters.every(drawsGrapheme)) return text;
  // The most of its characters that fit, found by halving: a prefix fits
  // whenever a longer one does.
  let fits = 0;
  let over = characters.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (headlineSize(characters.slice(0, middle).join('')) !== null) fits = middle;
    else over = middle;
  }
  throw refusal(
    `The headline is too long for its line: about ${fits} of its ${characters.length} characters fit. ` +
      'Shorten it, or leave headline out.',
    'headline_too_long',
    context
  );
}

/**
 * The stationery a letter preview was asked for, checked: the theme with
 * what it prints, for the layout, the draft and the output, or a refusal
 * that says what to change. Undefined while stationery is not offered
 * (LETTER_IRL_STATIONERY_ENABLED is off, or our renderer does not draw the
 * previews): the letter is then Classic, as before stationery, and the
 * output says nothing of it. A stray theme, initials or headline then is
 * refused rather than quietly printed on a plain page: registerTools passes
 * them through to here. Classic itself is never refused, offered or not.
 *
 * Offered, a preview without `stationery` is Classic. Each theme but Classic
 * prints the date line; Monogram prints initials and Celebration an
 * optional headline, and each is refused with a theme that does not print
 * it. Whether the slots' characters print is the printable check's
 * (validatePrintableLetter), and whether the letter still fits its page,
 * below a headline, the layout's (layoutLetterForPreview).
 */
export function previewStationery(
  input: StationeryInput,
  senderName: string,
  context: ToolContext,
  renderer: 'html' | 'pdf'
): Stationery | undefined {
  if (!isStationeryEnabled() || renderer !== 'pdf') {
    const asked = (value: unknown) => value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
    const classic = typeof input.stationery === 'string' && input.stationery.trim().toLowerCase() === 'classic';
    if ((asked(input.stationery) && !classic) || asked(input.monogram) || asked(input.headline)) {
      throw refusal(
        'Stationery is not available yet. Leave stationery, monogram and headline out, and the letter prints on a plain page.',
        'not_offered',
        context
      );
    }
    return undefined;
  }

  const theme = optionalText(input.stationery, 'stationery', `one of ${THEME_LIST}`, context)?.toLowerCase();
  const monogram = optionalText(input.monogram, 'monogram', 'text: one to three letters, such as "JMS"', context);
  const headline = optionalText(input.headline, 'headline', 'text', context);
  if (theme !== undefined && !(STATIONERY_THEMES as readonly string[]).includes(theme)) {
    throw refusal(`stationery must be one of ${THEME_LIST}.`, 'unknown_theme', context);
  }
  const chosen = (theme ?? 'classic') as StationeryTheme;
  if (monogram !== undefined && chosen !== 'monogram') {
    throw refusal(
      'Initials print only on the monogram stationery. Choose stationery "monogram", or leave monogram out.',
      'monogram_without_theme',
      context
    );
  }
  if (headline !== undefined && chosen !== 'celebration') {
    throw refusal(
      'A headline prints only on the celebration stationery. Choose stationery "celebration", or leave headline out.',
      'headline_without_theme',
      context
    );
  }
  if (chosen === 'classic') return { theme: 'classic' };

  const stationery: Stationery = { theme: chosen, dateLine: dateLineFor(context.now()) };
  if (chosen === 'monogram') stationery.monogram = initialsFor(monogram, senderName, context);
  if (chosen === 'celebration' && headline !== undefined) {
    const printed = headlineFor(headline, context);
    if (printed !== undefined) stationery.headline = printed;
  }
  return stationery;
}

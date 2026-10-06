/**
 * A letter preview's stationery (#563): the `stationery`, `monogram` and
 * `headline` the three letter previews take, checked against what each theme
 * prints (src/render/stationery.ts), as the draft records it and the
 * preview's output says it.
 */

import type { ToolContext } from '../contracts/types.js';
import { isCustomStationeryOffered } from '../config/customStationery.js';
import { isStationeryEnabled } from '../config/stationery.js';
import {
  CUSTOM_THEME,
  drawsGrapheme,
  headlineSize,
  slotText,
  STATIONERY_SLOT_MAX_LENGTH,
  STATIONERY_THEMES,
  visualOrder,
  type StationeryDesign,
  type StationeryTheme,
  type ThemeStationery
} from '../render/index.js';
import { withoutInvisible } from '../render/bidi.js';
import { clampMarks } from '../render/marks.js';
import { SCHEDULE_TIME_ZONE } from '../services/deliverySchedule.js';
import { rememberedStationery } from '../services/stationeryDefaultService.js';
import { getDesign, rememberedDesign, type SavedDesign } from '../services/stationeryDesignService.js';

/**
 * Why a preview is drawn in its theme (#563): asked for in the call, the
 * account's remembered choice (migration 045), or Classic, the default.
 */
export type StationerySource = 'asked' | 'remembered' | 'default';

/**
 * A saved design as a preview draws it (#649): the custom theme with its
 * design, the name it was saved under, and its id, which the draft does not
 * keep (stationeryOf drops it): the draft keeps its own copy of the design.
 */
export type DesignStationery = Omit<ThemeStationery, 'theme'> & {
  theme: typeof CUSTOM_THEME;
  design: StationeryDesign;
  name: string;
  designId: string;
};

/** A preview's stationery, and why it is that one. The draft stores the stationery alone (stationeryOf drops the rest). */
export type PreviewStationery = (ThemeStationery | DesignStationery) & { source: StationerySource };

/** The previews' stationery arguments, as they arrive: unchecked. */
export interface StationeryInput {
  stationery?: unknown;
  monogram?: unknown;
  headline?: unknown;
  /** A saved design's id (#649), in place of a theme. */
  stationeryDesignId?: unknown;
}

/** The account's remembered choice: a theme, or one of its saved designs (#649). */
export type RememberedChoice = StationeryTheme | SavedDesign;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clusters = (text: string): string[] => [...graphemes.segment(text)].map(({ segment }) => segment);

/** A letter, with any marks it carries: what a monogram is made of. */
const LETTER = /^\p{L}\p{M}*$/u;
const MONOGRAM_MAX_LETTERS = 3;

/**
 * What a refusal about a theme the call did not name starts with: where the
 * theme came from, the account's remembered choice. Empty otherwise.
 */
export function rememberedPrefix(stationery: { theme: string; source?: StationerySource; name?: string } | undefined): string {
  if (stationery?.source !== 'remembered') return '';
  return stationery.theme === CUSTOM_THEME
    ? `The account's remembered stationery is its saved design "${stationery.name ?? ''}". `
    : `The account's remembered stationery is ${stationery.theme}. `;
}

/** The themes, as a sentence names them: "classic, monogram, ... or handwritten". */
export const THEME_LIST = `${STATIONERY_THEMES.slice(0, -1).join(', ')} or ${STATIONERY_THEMES[STATIONERY_THEMES.length - 1]}`;

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
 * Titles before a name and suffixes after it, which are no one's initials:
 * "Dr. Pat Rivera" and "Pat Rivera Jr." are both PR. Each is skipped only
 * where it stands, a title at the start and a suffix at the end, so "Md.
 * Rafiqul Islam", where Md. is Muhammad, keeps its M. Compared in lower case
 * without full stops ("M.D." is md).
 */
const TITLES: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'rev', 'prof', 'sir', 'dame', 'capt', 'fr', 'mme'
]);
const SUFFIXES: ReadonlySet<string> = new Set([
  'jr', 'sr', 'jnr', 'snr', 'ii', 'iii', 'iv', 'md', 'phd', 'esq', 'dds', 'cpa', 'rn'
]);

/** A name's words without the titles before it and the suffixes after it. */
function nameWords(words: string[]): string[] {
  const key = (word: string) => word.replace(/\./g, '').toLowerCase();
  let start = 0;
  let end = words.length;
  while (start < end && TITLES.has(key(words[start]))) start += 1;
  while (end > start && SUFFIXES.has(key(words[end - 1]))) end -= 1;
  return words.slice(start, end);
}

/**
 * The initials a Monogram letter prints: the `monogram` asked for, or the
 * initials of the return address's name. Asked for, spaces and full stops
 * are dropped ("J. M. S." is JMS) and what is left must be one to three
 * letters, as written. From the name, each word that starts with a letter
 * gives its first, in capitals, but a title or a suffix; past three, the
 * first two and the last, as a first, middle and last name would.
 */
function initialsFor(
  asked: string | undefined,
  senderName: string,
  context: ToolContext,
  /** What a refusal starts with when the stationery was the account's remembered choice (rememberedPrefix); else empty. */
  remembering: string,
  /** The stationery as a sentence names it: "monogram stationery", or "saved stationery design" (#649). */
  named: string
): string {
  if (asked !== undefined) {
    // As a slot prints it, without what prints nothing, spaces and full
    // stops; its marks clamped again after, so no letter keeps the marks of two.
    const letters = clusters(clampMarks(withoutInvisible(slotText(asked)).replace(/[ .]/g, '')));
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
  const initials = nameWords(withoutInvisible(slotText(senderName)).split(/[\s,]+/u).filter(word => word !== ''))
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
      remembering +
        `The ${named} prints initials, and the return address's name has none to use. ` +
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
 * Offered, a preview without `stationery` is drawn in `remembered`, the
 * account's last choice, or else Classic, and says which (`source`). Each
 * theme but Classic prints the date line; Monogram prints initials and
 * Celebration an optional headline, and each is refused with a theme that
 * does not print it. Whether the slots' characters print is the printable
 * check's (validatePrintableLetter), and whether the letter still fits its
 * page, below a headline, the layout's (layoutLetterForPreview).
 *
 * A saved design (#649), while designs are offered: `stationeryDesignId` names
 * one of the account's, which the caller has read (`askedDesign`, null when it
 * is none of the account's), in place of a theme; without either, the
 * account's remembered design comes before its remembered theme (the caller
 * passes whichever it remembers last). A design prints the date line, initials
 * only with the monogram ornament, and a headline.
 */
export function previewStationery(
  input: StationeryInput,
  senderName: string,
  context: ToolContext,
  renderer: 'html' | 'pdf',
  remembered: RememberedChoice | null = null,
  askedDesign: SavedDesign | null = null
): PreviewStationery | undefined {
  if (!isStationeryEnabled() || renderer !== 'pdf') {
    const asked = (value: unknown) => value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
    const classic = typeof input.stationery === 'string' && input.stationery.trim().toLowerCase() === 'classic';
    if ((asked(input.stationery) && !classic) || asked(input.monogram) || asked(input.headline) || asked(input.stationeryDesignId)) {
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
  const designId = optionalText(input.stationeryDesignId, 'stationeryDesignId', "a saved design's designId", context);
  if (designId !== undefined) {
    if (!isCustomStationeryOffered()) {
      throw refusal('Saved stationery designs are not available yet. Leave stationeryDesignId out, or name a stationery.', 'design_not_offered', context);
    }
    if (theme !== undefined) {
      throw refusal('Give stationery or stationeryDesignId, not both: a saved design is a stationery of its own.', 'design_with_theme', context);
    }
    if (!askedDesign || askedDesign.designId.toLowerCase() !== designId.toLowerCase()) {
      throw refusal(
        "That stationery design was not found. list_stationery_designs lists the account's designs, with their designId.",
        'design_not_found',
        context
      );
    }
  }
  const source: StationerySource = theme !== undefined || designId !== undefined ? 'asked' : remembered ? 'remembered' : 'default';
  // A design asked for, or, with nothing asked, the one the account remembers.
  const design = designId !== undefined ? askedDesign : theme === undefined && remembered && typeof remembered === 'object' ? remembered : null;
  if (design) return designStationery(design, { monogram, headline }, senderName, context, source);
  const chosen = (theme ?? (typeof remembered === 'string' ? remembered : null) ?? 'classic') as StationeryTheme;
  // A refusal about a theme the call did not name says where it came from.
  const remembering = rememberedPrefix({ theme: chosen, source });
  if (monogram !== undefined && chosen !== 'monogram') {
    throw refusal(
      remembering + 'Initials print only on the monogram stationery. Choose stationery "monogram", or leave monogram out.',
      'monogram_without_theme',
      context
    );
  }
  if (headline !== undefined && chosen !== 'celebration') {
    throw refusal(
      remembering + 'A headline prints only on the celebration stationery. Choose stationery "celebration", or leave headline out.',
      'headline_without_theme',
      context
    );
  }
  if (chosen === 'classic') return { theme: 'classic', source };

  const stationery: PreviewStationery = { theme: chosen, dateLine: dateLineFor(context.now()), source };
  if (chosen === 'monogram') stationery.monogram = initialsFor(monogram, senderName, context, remembering, 'monogram stationery');
  if (chosen === 'celebration' && headline !== undefined) {
    const printed = headlineFor(headline, context);
    if (printed !== undefined) stationery.headline = printed;
  }
  return stationery;
}

/**
 * A saved design as a preview draws it (#649): its choices, its name and id,
 * the date line, initials only with the monogram ornament, and a headline.
 */
function designStationery(
  saved: SavedDesign,
  slots: { monogram: string | undefined; headline: string | undefined },
  senderName: string,
  context: ToolContext,
  source: StationerySource
): PreviewStationery {
  const stationery: PreviewStationery = {
    theme: CUSTOM_THEME,
    design: saved.design,
    name: saved.name,
    designId: saved.designId,
    dateLine: dateLineFor(context.now()),
    source
  };
  const remembering = rememberedPrefix(stationery);
  if (slots.monogram !== undefined && saved.design.ornament !== 'monogram') {
    throw refusal(
      remembering +
        'Initials print only on a design whose ornament is the monogram, and this design has another. Leave monogram out, or choose a design or stationery that prints initials.',
      'monogram_without_theme',
      context
    );
  }
  if (saved.design.ornament === 'monogram') {
    stationery.monogram = initialsFor(slots.monogram, senderName, context, remembering, 'saved stationery design');
  }
  if (slots.headline !== undefined) {
    const printed = headlineFor(slots.headline, context);
    if (printed !== undefined) stationery.headline = printed;
  }
  return stationery;
}

/**
 * previewStationery with what it needs read first: a design the call names
 * (#649), and the account's remembered choice, read only when it could apply:
 * stationery is offered, and the call asks for no theme and no design. The
 * remembered design comes first (remembering a theme forgets it), while
 * designs are offered.
 */
export async function chooseStationery(
  input: StationeryInput,
  senderName: string,
  context: ToolContext,
  renderer: 'html' | 'pdf'
): Promise<PreviewStationery | undefined> {
  const offered = isStationeryEnabled() && renderer === 'pdf';
  const designs = offered && isCustomStationeryOffered();
  const asksTheme = typeof input.stationery === 'string' ? input.stationery.trim() !== '' : input.stationery != null;
  const askedId = typeof input.stationeryDesignId === 'string' ? input.stationeryDesignId.trim() : '';
  const asksDesign = askedId !== '' || (input.stationeryDesignId != null && typeof input.stationeryDesignId !== 'string');
  const askedDesign = designs && askedId !== '' && !asksTheme ? await getDesign(context.user.userId, askedId) : null;
  let remembered: RememberedChoice | null = null;
  if (offered && !asksTheme && !asksDesign) {
    remembered = (designs ? await rememberedDesign(context.user.userId) : null) ?? (await rememberedStationery(context.user.userId));
  }
  return previewStationery(input, senderName, context, renderer, remembered, askedDesign);
}

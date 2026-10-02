/**
 * A postcard preview's front (#594): the `layout`, `caption` and `place` the
 * postcard preview takes, checked against what each layout prints
 * (src/render/postcard.ts), as the draft records it (postcard_front,
 * migration 048).
 */

import type { ToolContext } from '../contracts/types.js';
import { isPostcardLayoutsOffered } from '../config/postcardLayouts.js';
import {
  drawsGrapheme,
  drawsGraphemeIn,
  layoutPostcard,
  POSTCARD_FRONT_TEXT_MAX_LENGTH,
  PostcardFrontOverflow,
  slotText,
  visualOrder,
  type PostcardFront,
  type PostcardSizeName,
  type RenderImage
} from '../render/index.js';

/** The layouts a postcard preview takes: full bleed, as every postcard before, a border, or a greeting. */
export const POSTCARD_LAYOUTS = ['full_bleed', 'border', 'greetings'] as const;
export type PostcardLayoutChoice = (typeof POSTCARD_LAYOUTS)[number];

/**
 * The longest caption and place a preview takes, in characters as a reader
 * counts them (grapheme clusters), inside what a stored front may hold
 * (POSTCARD_FRONT_TEXT_MAX_LENGTH, in code units, which printedText also
 * checks). They bound narrow text at every size: 60 narrow letters fit a
 * caption, and 30 characters a place, on each. Wide letters and prose run
 * past the line first on a 4x6 or 6x9, which its own measure refuses (#600
 * review rounds 1 and 2).
 */
export const POSTCARD_CAPTION_MAX_LENGTH = 60;
export const POSTCARD_PLACE_MAX_LENGTH = 30;

/** The preview's three front arguments, as they arrive: unchecked. */
export interface PostcardFrontInput {
  layout?: unknown;
  caption?: unknown;
  place?: unknown;
}

/** Each size as a refusal names it. */
const SIZE_NAMES: Readonly<Record<PostcardSizeName, string>> = { '6x4': 'a 4x6', '6x9': 'a 6x9', '6x11': 'an 11x6' };

/** An image of the right shape and nothing else: the front's lines are measured without the photo. */
const MEASURING_IMAGE: RenderImage = { bytes: Buffer.alloc(0), mime: 'image/png', width: 3, height: 2 };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clusters = (text: string): string[] => [...graphemes.segment(text)].map(({ segment }) => segment);

function refusal(message: string, reason: string, context: ToolContext): Error {
  context.logger.warn(
    { correlationId: context.correlationId, event: 'quote.postcard.front_refused', reason },
    'A postcard front was refused'
  );
  return Object.assign(new Error(message), { diagnosticClass: 'validation_error' });
}

/** Whether a front argument was given: present, and not empty or blank, which models send for one left unset. */
function asked(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

/**
 * A caption or place as the front prints it: one line, as slotText makes a
 * stationery slot's, or undefined when it prints nothing. Longer than its
 * limit, it is refused. Whether its characters print is the printable
 * check's (validatePrintableCharacters), which the preview runs next.
 */
function printedText(value: unknown, name: 'caption' | 'place', max: number, context: ToolContext): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw refusal(`The ${name} must be text.`, `${name}_not_text`, context);
  const text = slotText(value);
  if (visualOrder(text).trim() === '') return undefined;
  if (clusters(text).length > max) {
    throw refusal(`The ${name} is too long: it may hold at most ${max} characters. Shorten it.`, `${name}_too_long`, context);
  }
  // What a stored front holds is counted in code units (postcardFrontOf), and
  // an accent written apart from its letter takes more of them than it shows:
  // past that, the draft could not store the front (#600 review round 2).
  if (text.length > POSTCARD_FRONT_TEXT_MAX_LENGTH) {
    throw refusal(
      `The ${name} is too long: it may hold at most ${max} characters, and fewer where accents are written apart from ` +
        `their letters. Shorten it.`,
      `${name}_too_long`,
      context
    );
  }
  return text;
}

/** The text a front prints on its line, and the face and case it prints in. */
function lineOf(front: PostcardFront): { text: string; drawn: string; prints: (grapheme: string) => boolean } | undefined {
  if (front.layout === 'border') {
    return front.caption === undefined ? undefined : { text: front.caption, drawn: front.caption, prints: drawsGraphemeIn('Caveat-Regular') };
  }
  return { text: front.place, drawn: front.place.toUpperCase(), prints: drawsGrapheme };
}

/** Whether the front's line fits at its size: the renderer's own measure. */
function fitsLine(front: PostcardFront, size: PostcardSizeName): boolean {
  try {
    layoutPostcard({ message: '', image: MEASURING_IMAGE, size, ...front });
    return true;
  } catch (error) {
    if (error instanceof PostcardFrontOverflow) return false;
    throw error;
  }
}

/**
 * The front, checked to fit its line at the postcard's size; otherwise
 * refused, saying how much of it fits. A line holding a character its face
 * cannot draw is left to the printable check, which names it: measured, its
 * boxes would only say "too long".
 */
function fitted(front: PostcardFront, size: PostcardSizeName, context: ToolContext, kept = false): PostcardFront {
  const line = lineOf(front);
  if (!line || !clusters(line.drawn).every(line.prints) || fitsLine(front, size)) return front;
  const name = front.layout === 'border' ? 'caption' : 'place';
  const characters = clusters(line.text);
  const withText = (text: string): PostcardFront =>
    front.layout === 'border' ? { layout: 'border', caption: text } : { layout: 'greetings', place: text };
  // The most of its characters that fit, found by halving: a shorter line
  // fits whenever a longer one does.
  let fits = 0;
  let over = characters.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (fitsLine(withText(characters.slice(0, middle).join('')), size)) fits = middle;
    else over = middle;
  }
  // A line the postcard already has, measured at a new size, names itself as
  // such, and how to give a shorter one with the size (#601 review round 1).
  const layout = front.layout === 'border' ? 'border' : 'greetings';
  throw refusal(
    `The ${kept ? `postcard's ` : ''}${name} is too long for its line on the front of ${SIZE_NAMES[size]} postcard: about ` +
      `${fits} of its ${characters.length} characters fit. ` +
      (kept ? `To change the size, give layout ${layout} and a shorter ${name} with it.` : 'Shorten it.'),
    `${name}_too_long`,
    context
  );
}

/**
 * The front a postcard preview was asked for, checked: a border with its
 * caption, or a greeting with its place, for the layout, the draft and the
 * print, or undefined for full bleed. A refusal says what to change.
 *
 * While the layouts are not offered (LETTER_IRL_POSTCARD_LAYOUTS_ENABLED is
 * off, or our renderer does not draw the postcard), every front is full
 * bleed, as before them. A layout, caption or place then asked for is
 * refused rather than quietly printed as the photo alone: registerTools
 * passes them through to here. Full bleed itself is never refused.
 *
 * Offered, each layout takes only its own line: a caption goes with a
 * border, which may have none, and a place with a greeting, which needs one.
 */
export function previewPostcardFront(
  input: PostcardFrontInput,
  size: PostcardSizeName,
  context: ToolContext,
  renderer: 'html' | 'pdf'
): PostcardFront | undefined {
  if (!isPostcardLayoutsOffered() || renderer !== 'pdf') {
    const fullBleed = typeof input.layout === 'string' && input.layout.trim().toLowerCase() === 'full_bleed';
    if ((asked(input.layout) && !fullBleed) || asked(input.caption) || asked(input.place)) {
      throw refusal(
        'Postcard layouts are not offered here: the front is the photo alone. Leave layout, caption and place out.',
        'layouts_not_offered',
        context
      );
    }
    return undefined;
  }

  let layout: PostcardLayoutChoice = 'full_bleed';
  if (asked(input.layout)) {
    const named = typeof input.layout === 'string' ? input.layout.trim().toLowerCase() : '';
    if (!(POSTCARD_LAYOUTS as readonly string[]).includes(named)) {
      throw refusal('The layout must be full_bleed, border or greetings.', 'layout_unknown', context);
    }
    layout = named as PostcardLayoutChoice;
  }
  const caption = printedText(input.caption, 'caption', POSTCARD_CAPTION_MAX_LENGTH, context);
  const place = printedText(input.place, 'place', POSTCARD_PLACE_MAX_LENGTH, context);

  if (layout === 'full_bleed') {
    if (caption !== undefined) {
      throw refusal('A caption goes with the border layout: set layout to border, or leave caption out.', 'caption_without_border', context);
    }
    if (place !== undefined) {
      throw refusal('A place goes with the greetings layout: set layout to greetings, or leave place out.', 'place_without_greetings', context);
    }
    return undefined;
  }
  if (layout === 'border') {
    if (place !== undefined) {
      throw refusal('A border takes a caption, not a place: leave place out, or set layout to greetings.', 'place_on_border', context);
    }
    return fitted(caption === undefined ? { layout: 'border' } : { layout: 'border', caption }, size, context);
  }
  if (caption !== undefined) {
    throw refusal('A greeting takes a place, not a caption: leave caption out, or set layout to border.', 'caption_on_greetings', context);
  }
  if (place === undefined) {
    throw refusal('The greetings layout needs a place: "Greetings from" where?', 'place_missing', context);
  }
  return fitted({ layout: 'greetings', place }, size, context);
}

/** What the printable check is given for a front's line, with the face it prints in: none for full bleed or a bare border. */
export function frontPrintedText(front: PostcardFront | undefined): Array<{ field: string; where: string; text: string; prints: (grapheme: string) => boolean }> {
  if (!front) return [];
  const line = lineOf(front);
  if (!line) return [];
  return front.layout === 'border'
    ? [{ field: 'caption', where: 'in the caption, which prints in a handwriting typeface that has fewer characters', text: line.drawn, prints: line.prints }]
    : [{ field: 'place', where: 'in the place, which prints in capitals', text: line.drawn, prints: line.prints }];
}

/**
 * A front kept as it was, measured again at another size (set_postcard_style,
 * #594): itself when its line fits there, and otherwise refused as a preview
 * refuses one, saying how much of it fits.
 */
export function fitPostcardFront(front: PostcardFront, size: PostcardSizeName, context: ToolContext): PostcardFront {
  return fitted(front, size, context, true);
}

/** A front as a tool's answer names it (#594): its layout, with its caption or place. */
export function frontChoice(front: PostcardFront | undefined): { layout: PostcardLayoutChoice; caption?: string; place?: string } {
  if (!front) return { layout: 'full_bleed' };
  if (front.layout === 'border') return front.caption === undefined ? { layout: 'border' } : { layout: 'border', caption: front.caption };
  return { layout: 'greetings', place: front.place };
}

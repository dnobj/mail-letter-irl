/**
 * A postcard preview's front (#594): the layout, caption and place it takes,
 * checked against what each layout prints, before anything is fetched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  frontPrintedText,
  POSTCARD_CAPTION_MAX_LENGTH,
  POSTCARD_PLACE_MAX_LENGTH,
  previewPostcardFront
} from '../../../src/tools/postcardFrontInput.js';
import { layoutPostcard, POSTCARD_FRONT_TEXT_MAX_LENGTH, postcardFrontOf, PostcardFrontOverflow } from '../../../src/render/index.js';
import type { ToolContext } from '../../../src/contracts/types.js';

function context(): ToolContext {
  return {
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never
  } as unknown as ToolContext;
}

/** The refusal a call makes, with its message and class. */
function refused(run: () => unknown): Error & { diagnosticClass?: string } {
  try {
    run();
  } catch (error) {
    return error as Error & { diagnosticClass?: string };
  }
  throw new Error('expected a refusal');
}

const IMAGE = { bytes: Buffer.alloc(0), mime: 'image/png' as const, width: 3, height: 2 };
/** Whether a front's line fits at a size, by the renderer's own measure. */
function fits(front: Parameters<typeof layoutPostcard>[0], size: '6x4' | '6x9' | '6x11'): boolean {
  try {
    layoutPostcard({ ...front, size });
    return true;
  } catch (error) {
    if (error instanceof PostcardFrontOverflow) return false;
    throw error;
  }
}

beforeEach(() => {
  vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('previewPostcardFront while the layouts are not offered', () => {
  it.each([
    ['the flag is off', () => vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', ''), 'pdf'],
    ['our renderer does not draw the postcard', () => undefined, 'html']
  ] as const)('is full bleed when %s, and refuses any other front asked for', (_name, setUp, renderer) => {
    setUp();
    for (const input of [{}, { layout: 'full_bleed' }, { layout: ' FULL_BLEED ' }, { layout: '', caption: ' ', place: null }]) {
      expect(previewPostcardFront(input, '6x9', context(), renderer), JSON.stringify(input)).toBeUndefined();
    }
    for (const input of [{ layout: 'border' }, { caption: 'Cape Cod' }, { place: 'Asheville' }, { layout: 'greetings', place: 'Rye' }]) {
      const ctx = context();
      const error = refused(() => previewPostcardFront(input, '6x9', ctx, renderer));
      expect(error.message, JSON.stringify(input)).toBe(
        'Postcard layouts are not offered here: the front is the photo alone. Leave layout, caption and place out.'
      );
      expect(error.diagnosticClass).toBe('validation_error');
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'quote.postcard.front_refused', reason: 'layouts_not_offered' }),
        expect.any(String)
      );
    }
  });
});

describe('previewPostcardFront while the layouts are offered', () => {
  it('is full bleed by default, or when named so', () => {
    for (const input of [{}, { layout: 'full_bleed' }, { layout: ' Full_Bleed ' }, { layout: '', caption: '', place: '  ' }]) {
      expect(previewPostcardFront(input, '6x9', context(), 'pdf'), JSON.stringify(input)).toBeUndefined();
    }
  });

  it('gives a border its caption as it prints, on one line, or none', () => {
    expect(previewPostcardFront({ layout: 'border' }, '6x9', context(), 'pdf')).toEqual({ layout: 'border' });
    expect(previewPostcardFront({ layout: 'Border', caption: '  Cape Cod,\n  August\t2026 ' }, '6x9', context(), 'pdf'))
      .toEqual({ layout: 'border', caption: 'Cape Cod, August 2026' });
    // A caption that prints nothing is no caption.
    for (const caption of ['   ', '\u200B', '\n\t']) {
      expect(previewPostcardFront({ layout: 'border', caption }, '6x9', context(), 'pdf'), JSON.stringify(caption)).toEqual({ layout: 'border' });
    }
  });

  it('gives a greeting its place as written, which prints in capitals', () => {
    expect(previewPostcardFront({ layout: 'greetings', place: ' Asheville ' }, '6x9', context(), 'pdf'))
      .toEqual({ layout: 'greetings', place: 'Asheville' });
  });

  it.each([
    [{ layout: 'collage' }, 'The layout must be full_bleed, border or greetings.', 'layout_unknown'],
    [{ layout: 3 }, 'The layout must be full_bleed, border or greetings.', 'layout_unknown'],
    [{ caption: 'Cape Cod' }, 'A caption goes with the border layout: set layout to border, or leave caption out.', 'caption_without_border'],
    [{ place: 'Rye' }, 'A place goes with the greetings layout: set layout to greetings, or leave place out.', 'place_without_greetings'],
    [{ layout: 'border', place: 'Rye' }, 'A border takes a caption, not a place: leave place out, or set layout to greetings.', 'place_on_border'],
    [{ layout: 'greetings', place: 'Rye', caption: 'Hi' }, 'A greeting takes a place, not a caption: leave caption out, or set layout to border.', 'caption_on_greetings'],
    [{ layout: 'greetings' }, 'The greetings layout needs a place: "Greetings from" where?', 'place_missing'],
    [{ layout: 'greetings', place: ' \u200B ' }, 'The greetings layout needs a place: "Greetings from" where?', 'place_missing'],
    [{ layout: 'border', caption: 42 }, 'The caption must be text.', 'caption_not_text'],
    [{ layout: 'greetings', place: ['Rye'] }, 'The place must be text.', 'place_not_text'],
    [{ layout: 'border', caption: 'x'.repeat(POSTCARD_CAPTION_MAX_LENGTH + 1) }, `The caption is too long: it may hold at most ${POSTCARD_CAPTION_MAX_LENGTH} characters. Shorten it.`, 'caption_too_long'],
    [{ layout: 'greetings', place: 'x'.repeat(POSTCARD_PLACE_MAX_LENGTH + 1) }, `The place is too long: it may hold at most ${POSTCARD_PLACE_MAX_LENGTH} characters. Shorten it.`, 'place_too_long']
  ])('refuses %o, saying what to change', (input, message, reason) => {
    const ctx = context();
    const error = refused(() => previewPostcardFront(input, '6x9', ctx, 'pdf'));
    expect(error.message).toBe(message);
    expect(error.diagnosticClass).toBe('validation_error');
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason }), expect.any(String));
  });

  it.each([
    ['6x4', 'a 4x6'],
    ['6x9', 'a 6x9'],
    ['6x11', 'an 11x6']
  ] as const)('refuses a %s caption too wide for its line, saying how much of it fits', (size, named) => {
    // The most a preview takes, in wide letters: wider than the photo at
    // every size, an 11x6's included, which prose of this length is not.
    const caption = 'W'.repeat(POSTCARD_CAPTION_MAX_LENGTH);
    expect(fits({ message: '', image: IMAGE, layout: 'border', caption: 'Cape Cod in August, '.repeat(3).trim() }, '6x11')).toBe(true);
    expect(fits({ message: '', image: IMAGE, layout: 'border', caption }, size)).toBe(false);
    const error = refused(() => previewPostcardFront({ layout: 'border', caption }, size, context(), 'pdf'));
    const match = /^The caption is too long for its line on the front of (a 4x6|a 6x9|an 11x6) postcard: about (\d+) of its (\d+) characters fit\. Shorten it\.$/.exec(error.message)!;
    expect(match, error.message).not.toBeNull();
    expect(match[1]).toBe(named);
    const [fitting, all] = [Number(match[2]), Number(match[3])];
    expect(all).toBe([...caption].length);
    // As many as fit, and no more.
    expect(fits({ message: '', image: IMAGE, layout: 'border', caption: caption.slice(0, fitting) }, size)).toBe(true);
    expect(fits({ message: '', image: IMAGE, layout: 'border', caption: caption.slice(0, fitting + 1) }, size)).toBe(false);
  });

  it('refuses a place too long for its line at its smallest, saying how much of it fits', () => {
    const place = 'W'.repeat(POSTCARD_PLACE_MAX_LENGTH);
    const error = refused(() => previewPostcardFront({ layout: 'greetings', place }, '6x4', context(), 'pdf'));
    const fitting = Number(/about (\d+) of its 30 characters fit/.exec(error.message)![1]);
    expect(fits({ message: '', image: IMAGE, layout: 'greetings', place: place.slice(0, fitting) }, '6x4')).toBe(true);
    expect(fits({ message: '', image: IMAGE, layout: 'greetings', place: place.slice(0, fitting + 1) }, '6x4')).toBe(false);
  });

  it('counts the caps in characters as a reader counts them, not in code units', () => {
    // Each wave is one character of two code units.
    const wave = String.fromCodePoint(0x1f30a);
    const caption = wave.repeat(POSTCARD_CAPTION_MAX_LENGTH);
    expect(caption.length).toBe(2 * POSTCARD_CAPTION_MAX_LENGTH);
    // Within the cap, and left to the printable check, which Caveat's lack of it meets.
    expect(previewPostcardFront({ layout: 'border', caption }, '6x9', context(), 'pdf')).toEqual({ layout: 'border', caption });
    expect(refused(() => previewPostcardFront({ layout: 'border', caption: caption + wave }, '6x9', context(), 'pdf')).message).toBe(
      `The caption is too long: it may hold at most ${POSTCARD_CAPTION_MAX_LENGTH} characters. Shorten it.`
    );
    const place = wave.repeat(POSTCARD_PLACE_MAX_LENGTH);
    expect(previewPostcardFront({ layout: 'greetings', place }, '6x9', context(), 'pdf')).toEqual({ layout: 'greetings', place });
    expect(refused(() => previewPostcardFront({ layout: 'greetings', place: place + wave }, '6x9', context(), 'pdf')).message).toBe(
      `The place is too long: it may hold at most ${POSTCARD_PLACE_MAX_LENGTH} characters. Shorten it.`
    );
  });

  it('refuses a line a stored front could not hold, though its characters are within the cap (#600 review round 2)', () => {
    // An e with two accents written apart from it: one character of three code units.
    const accented = String.fromCharCode(0x65, 0x323, 0x302);
    const caption = accented.repeat(POSTCARD_CAPTION_MAX_LENGTH);
    expect(caption.length).toBeGreaterThan(POSTCARD_FRONT_TEXT_MAX_LENGTH);
    expect(refused(() => previewPostcardFront({ layout: 'border', caption }, '6x11', context(), 'pdf')).message).toBe(
      `The caption is too long: it may hold at most ${POSTCARD_CAPTION_MAX_LENGTH} characters, and fewer where accents are ` +
        'written apart from their letters. Shorten it.'
    );
    // Four accents on one letter: one character of five code units.
    const stacked = String.fromCharCode(0x65, 0x301, 0x301, 0x301, 0x301);
    expect(refused(() => previewPostcardFront({ layout: 'greetings', place: stacked.repeat(POSTCARD_PLACE_MAX_LENGTH) }, '6x4', context(), 'pdf')).message)
      .toContain(`The place is too long: it may hold at most ${POSTCARD_PLACE_MAX_LENGTH} characters, and fewer where accents`);

    // Every front the preview takes is one the print reads back.
    const lines = [accented.repeat(40), stacked.repeat(24), String.fromCodePoint(0x1f30a).repeat(60), 'i'.repeat(60), 'Cape Cod, August 2026'];
    let taken = 0;
    for (const size of ['6x4', '6x9', '6x11'] as const) {
      for (const text of lines) {
        for (const input of [{ layout: 'border', caption: text }, { layout: 'greetings', place: text }]) {
          let front;
          try {
            front = previewPostcardFront(input, size, context(), 'pdf');
          } catch {
            continue;
          }
          taken += 1;
          expect(postcardFrontOf(front), `${size} ${input.layout} ${text.length}`).toEqual(front);
        }
      }
    }
    expect(taken).toBeGreaterThan(10);
  });

  it('leaves a line its face cannot draw to the printable check, unmeasured, which names the character', () => {
    // Caveat has no Greek: measured, its boxes would only say "too long".
    const caption = 'Ωμέγα '.repeat(10).trim();
    expect(previewPostcardFront({ layout: 'border', caption }, '6x4', context(), 'pdf')).toEqual({ layout: 'border', caption });
  });
});

describe('frontPrintedText', () => {
  it('gives the printable check the line each front prints, in the face and case it prints in', () => {
    expect(frontPrintedText(undefined)).toEqual([]);
    expect(frontPrintedText({ layout: 'border' })).toEqual([]);
    const [caption] = frontPrintedText({ layout: 'border', caption: 'Ω Cape Cod' });
    expect(caption).toMatchObject({
      field: 'caption',
      where: 'in the caption, which prints in a handwriting typeface that has fewer characters',
      text: 'Ω Cape Cod'
    });
    // Caveat has no Greek; Tinos has.
    expect(caption.prints('Ω')).toBe(false);
    expect(caption.prints('C')).toBe(true);
    const [place] = frontPrintedText({ layout: 'greetings', place: 'Ωmaha' });
    expect(place).toMatchObject({ field: 'place', where: 'in the place, which prints in capitals', text: 'ΩMAHA' });
    expect(place.prints('Ω')).toBe(true);
  });
});

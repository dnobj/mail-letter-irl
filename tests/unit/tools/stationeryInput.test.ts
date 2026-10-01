/**
 * A letter preview's stationery (#563): what the three letter previews accept
 * as `stationery`, `monogram` and `headline`, checked against what each theme
 * prints, and refused, saying what to change, when it cannot print as asked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/services/stationeryDefaultService.js', () => ({
  rememberedStationery: vi.fn().mockResolvedValue(null),
  rememberStationery: vi.fn().mockResolvedValue(undefined)
}));

import { chooseStationery, dateLineFor, previewStationery } from '../../../src/tools/stationeryInput.js';
import { rememberedStationery } from '../../../src/services/stationeryDefaultService.js';
import { drawsGrapheme, headlineSize, STATIONERY_SLOT_MAX_LENGTH } from '../../../src/render/index.js';
import type { ToolContext } from '../../../src/contracts/types.js';

/** 14:00 in New York on October 1, 2026. */
const NOW = new Date('2026-10-01T18:00:00Z');

function context(now: Date = NOW): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => now,
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

const SENDER = 'Pat Rivera';
const offered = (input: Record<string, unknown>, senderName = SENDER, ctx = context()) => previewStationery(input, senderName, ctx, 'pdf');

/** The refusal `input` meets, with the reason logged for it. */
function refused(input: Record<string, unknown>, senderName = SENDER, renderer: 'html' | 'pdf' = 'pdf') {
  const ctx = context();
  let error: unknown;
  try {
    previewStationery(input, senderName, ctx, renderer);
  } catch (caught) {
    error = caught;
  }
  expect(error, JSON.stringify(input)).toBeInstanceOf(Error);
  expect((error as { diagnosticClass?: string }).diagnosticClass).toBe('validation_error');
  const warn = vi.mocked(ctx.logger.warn);
  expect(warn).toHaveBeenCalledTimes(1);
  const [fields] = warn.mock.calls[0] as unknown as [{ event: string; reason: string }];
  expect(fields.event).toBe('quote.stationery_refused');
  return { message: (error as Error).message, reason: fields.reason };
}

beforeEach(() => {
  vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('while stationery is not offered', () => {
  it('is nothing at all: no theme, nothing recorded, the letter as before', () => {
    for (const renderer of ['pdf', 'html'] as const) {
      vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', renderer === 'pdf' ? '' : 'true');
      for (const input of [{}, { stationery: '' }, { stationery: null, monogram: '  ', headline: '' }, { stationery: ' Classic ' }]) {
        expect(previewStationery(input, SENDER, context(), renderer), JSON.stringify(input)).toBeUndefined();
      }
    }
  });

  it('refuses a theme, initials or a headline rather than print a plain page', () => {
    for (const renderer of ['pdf', 'html'] as const) {
      vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', renderer === 'pdf' ? '' : 'true');
      for (const input of [
        { stationery: 'botanical' },
        { stationery: 'floral' },
        { stationery: 7 },
        { monogram: 'PR' },
        { stationery: 'classic', headline: 'Hello' },
        { headline: { text: 'Hello' } }
      ]) {
        const { message, reason } = refused(input, SENDER, renderer);
        expect(message).toBe('Stationery is not available yet. Leave stationery, monogram and headline out, and the letter prints on a plain page.');
        expect(reason).toBe('not_offered');
      }
    }
  });
});

describe('the theme', () => {
  it('is Classic when none is asked for, by default, with nothing it prints', () => {
    for (const input of [{}, { stationery: '' }, { stationery: null }]) {
      expect(offered(input), JSON.stringify(input)).toEqual({ theme: 'classic', source: 'default' });
    }
    for (const input of [{ stationery: 'classic' }, { stationery: ' CLASSIC ' }]) {
      expect(offered(input), JSON.stringify(input)).toEqual({ theme: 'classic', source: 'asked' });
    }
  });

  it('is the one asked for, in any case, with the date line every theme but Classic prints', () => {
    expect(offered({ stationery: ' Botanical ' })).toEqual({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'asked' });
    expect(offered({ stationery: 'celebration' })).toEqual({ theme: 'celebration', dateLine: 'October 1, 2026', source: 'asked' });
  });

  it('refuses a theme it does not know, naming the ones it does', () => {
    for (const stationery of ['floral', 'typewriter']) {
      const { message, reason } = refused({ stationery });
      expect(message).toBe('stationery must be one of classic, monogram, botanical or celebration.');
      expect(reason).toBe('unknown_theme');
    }
    const { message, reason } = refused({ stationery: ['botanical'] });
    expect(message).toBe('stationery must be one of classic, monogram, botanical or celebration.');
    expect(reason).toBe('stationery_not_text');
  });
});

describe('the date line', () => {
  it('is the day on the New York calendar, written out', () => {
    // 22:00 in New York on September 30 is already October 1 in UTC.
    expect(dateLineFor(new Date('2026-10-01T02:00:00Z'))).toBe('September 30, 2026');
    expect(dateLineFor(new Date('2026-10-01T04:30:00Z'))).toBe('October 1, 2026');
    expect(dateLineFor(new Date('2027-01-09T15:00:00Z'))).toBe('January 9, 2027');
    expect(offered({ stationery: 'botanical' }, SENDER, context(new Date('2026-10-01T02:00:00Z'))).dateLine).toBe('September 30, 2026');
  });
});

describe('the monogram', () => {
  it("is the return address's initials when none is asked for, in capitals", () => {
    expect(offered({ stationery: 'monogram' })).toEqual({ theme: 'monogram', dateLine: 'October 1, 2026', monogram: 'PR', source: 'asked' });
    expect(offered({ stationery: 'monogram' }, 'pat rivera').monogram).toBe('PR');
    expect(offered({ stationery: 'monogram' }, '  Ada  ').monogram).toBe('A');
    expect(offered({ stationery: 'monogram' }, 'Mary Ann Smith').monogram).toBe('MAS');
  });

  it('takes the first two and the last past three, as a first, middle and last name', () => {
    expect(offered({ stationery: 'monogram' }, 'Mary Ann Elizabeth Smith').monogram).toBe('MAS');
  });

  it('skips a word that does not start with a letter, and keeps a letter with its marks', () => {
    expect(offered({ stationery: 'monogram' }, 'Pat "Sunny" Rivera 3rd').monogram).toBe('PR');
    const acute = String.fromCodePoint(0x301);
    expect(offered({ stationery: 'monogram' }, `e${acute}mile zola`).monogram).toBe(`E${acute}Z`);
  });

  it('keeps a letter whose capital is two letters, or one the font cannot draw, as written', () => {
    const sharpS = String.fromCodePoint(0xdf);
    expect(offered({ stationery: 'monogram' }, `${sharpS}ophie Lane`).monogram).toBe(`${sharpS}L`);
    // U+0264, whose capital U+A7CB Tinos has no glyph for.
    const ramsHorn = String.fromCodePoint(0x264);
    expect(drawsGrapheme(ramsHorn.toUpperCase())).toBe(false);
    expect(offered({ stationery: 'monogram' }, `${ramsHorn}sa test`).monogram).toBe(`${ramsHorn}T`);
  });

  it('skips titles and suffixes, which are no one\'s initials (review round 1)', () => {
    for (const [name, initials] of [
      ['Dr. Pat Rivera', 'PR'],
      ['Mrs. Pat Rivera', 'PR'],
      ['Pat Rivera Jr.', 'PR'],
      ['Pat Rivera III', 'PR'],
      ['Pat Rivera, M.D.', 'PR'],
      ['Prof Ada Byron Lovelace, PhD', 'ABL'],
      ['Rev. Dr. Martin Luther King Jr.', 'MLK']
    ]) {
      expect(offered({ stationery: 'monogram' }, name).monogram, name).toBe(initials);
    }
  });

  it('finds each word behind characters that print nothing and any space (review round 1)', () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const noBreak = String.fromCodePoint(0xa0);
    expect(offered({ stationery: 'monogram' }, `${zeroWidth}Pat Rivera`).monogram).toBe('PR');
    expect(offered({ stationery: 'monogram' }, `Pat${noBreak}Rivera`).monogram).toBe('PR');
    expect(offered({ stationery: 'monogram' }, 'Pat\tRivera').monogram).toBe('PR');
  });

  it('refuses a name with no initials to use', () => {
    for (const name of ['123 456', '  ', '"" 42']) {
      const { message, reason } = refused({ stationery: 'monogram' }, name);
      expect(message).toBe(
        'The monogram stationery prints initials, and the return address\'s name has none to use. ' +
          'Pass monogram with one to three letters, such as "JMS", or choose another stationery.'
      );
      expect(reason).toBe('monogram_no_initials');
    }
  });

  it('drops spaces before clamping marks, so no letter gathers the marks of two (review round 1)', () => {
    const acute = String.fromCodePoint(0x301);
    const initials = offered({ stationery: 'monogram', monogram: `a${acute.repeat(4)} ${acute.repeat(4)}` }).monogram!;
    expect(initials).toBe(`a${acute.repeat(4)}`);
    expect(drawsGrapheme(initials)).toBe(true);
  });

  it('takes the initials asked for as written, without spaces and full stops', () => {
    expect(offered({ stationery: 'monogram', monogram: 'J. M. S.' }).monogram).toBe('JMS');
    expect(offered({ stationery: 'monogram', monogram: ' jms ' }).monogram).toBe('jms');
    expect(offered({ stationery: 'monogram', monogram: 'Q' }).monogram).toBe('Q');
    // An empty monogram is none asked for.
    expect(offered({ stationery: 'monogram', monogram: '' }).monogram).toBe('PR');
  });

  it('refuses initials that are not one to three letters', () => {
    for (const monogram of ['ABCD', 'J2', 'J&S', '. .', 'A-B']) {
      const { message, reason } = refused({ stationery: 'monogram', monogram });
      expect(message, monogram).toBe(
        'monogram must be one to three letters, such as "JMS". Leave it out to use the initials of the return address\'s name.'
      );
      expect(reason).toBe('monogram_not_initials');
    }
    expect(refused({ stationery: 'monogram', monogram: 42 }).reason).toBe('monogram_not_text');
  });

  it('is refused with any other theme, or none', () => {
    for (const stationery of [undefined, 'classic', 'botanical', 'celebration']) {
      const { message, reason } = refused({ stationery, monogram: 'PR' });
      expect(message).toBe('Initials print only on the monogram stationery. Choose stationery "monogram", or leave monogram out.');
      expect(reason).toBe('monogram_without_theme');
    }
  });
});

describe('the headline', () => {
  it('is optional on Celebration', () => {
    expect(offered({ stationery: 'celebration' })).not.toHaveProperty('headline');
    expect(offered({ stationery: 'celebration', headline: '  ' })).not.toHaveProperty('headline');
  });

  it('prints as one line: spaces and line breaks collapse, the ends are trimmed', () => {
    expect(offered({ stationery: 'celebration', headline: '  Happy\n\nBirthday,   Sam!  ' })).toEqual({
      theme: 'celebration',
      dateLine: 'October 1, 2026',
      headline: 'Happy Birthday, Sam!',
      source: 'asked'
    });
  });

  it('is none when it would print nothing', () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    expect(offered({ stationery: 'celebration', headline: zeroWidth.repeat(3) })).not.toHaveProperty('headline');
  });

  it('is refused past its line, saying how much of it fits', () => {
    const headline = 'Happy birthday to the best brother anyone could ever hope to have, Sam!';
    expect(headlineSize(headline)).toBeNull();
    const { message, reason } = refused({ stationery: 'celebration', headline });
    const fits = Number(/about (\d+) of its (\d+) characters fit/.exec(message)![1]);
    expect(message).toBe(`The headline is too long for its line: about ${fits} of its ${headline.length} characters fit. Shorten it, or leave headline out.`);
    expect(reason).toBe('headline_too_long');
    // The most that fits: one more character does not.
    expect(headlineSize(headline.slice(0, fits))).not.toBeNull();
    expect(headlineSize(headline.slice(0, fits + 1))).toBeNull();
  });

  it('is refused past the stored bound however narrow it draws, so what a draft records reads back', () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const headline = 'Hi' + zeroWidth.repeat(STATIONERY_SLOT_MAX_LENGTH);
    expect(headlineSize(headline)).not.toBeNull();
    const { message, reason } = refused({ stationery: 'celebration', headline });
    expect(message).toBe(
      `The headline is too long: it may hold at most ${STATIONERY_SLOT_MAX_LENGTH} characters. Shorten it, or leave headline out.`
    );
    expect(reason).toBe('headline_too_long');
    // At the bound it is measured as usual.
    const atBound = 'Hi' + zeroWidth.repeat(STATIONERY_SLOT_MAX_LENGTH - 2);
    expect(offered({ stationery: 'celebration', headline: atBound }).headline).toBe(atBound);
  });

  it("leaves a headline the font cannot draw to the printable check, which names its characters, rather than call it too long", () => {
    // Each draws the font's missing-glyph box, so measured it would only be "too long".
    const han = String.fromCodePoint(0x4e2d).repeat(60);
    expect(headlineSize(han)).toBeNull();
    expect(offered({ stationery: 'celebration', headline: han }).headline).toBe(han);
  });

  it('is refused with any other theme, or none', () => {
    for (const stationery of [undefined, 'classic', 'botanical', 'monogram']) {
      const { message, reason } = refused({ stationery, headline: 'Hello' });
      expect(message).toBe('A headline prints only on the celebration stationery. Choose stationery "celebration", or leave headline out.');
      expect(reason).toBe('headline_without_theme');
    }
    expect(refused({ stationery: 'celebration', headline: 42 }).reason).toBe('headline_not_text');
  });
});

describe('the remembered theme (#563 PR 5)', () => {
  const remembering = (input: Record<string, unknown>, remembered: Parameters<typeof previewStationery>[4], senderName = SENDER) =>
    previewStationery(input, senderName, context(), 'pdf', remembered);

  it('draws a preview that asks for none in it, and says so', () => {
    expect(remembering({}, 'botanical')).toEqual({ theme: 'botanical', dateLine: 'October 1, 2026', source: 'remembered' });
    expect(remembering({ stationery: '' }, 'monogram')).toEqual({ theme: 'monogram', dateLine: 'October 1, 2026', monogram: 'PR', source: 'remembered' });
    // Classic remembered is Classic, chosen.
    expect(remembering({}, 'classic')).toEqual({ theme: 'classic', source: 'remembered' });
  });

  it('gives way to a theme asked for, Classic included', () => {
    expect(remembering({ stationery: 'classic' }, 'botanical')).toEqual({ theme: 'classic', source: 'asked' });
    expect(remembering({ stationery: 'celebration' }, 'botanical')).toMatchObject({ theme: 'celebration', source: 'asked' });
  });

  it("takes the call's initials and headline when the remembered theme prints them, and refuses them otherwise", () => {
    expect(remembering({ monogram: 'JMS' }, 'monogram')).toMatchObject({ theme: 'monogram', monogram: 'JMS', source: 'remembered' });
    expect(remembering({ headline: 'Hooray' }, 'celebration')).toMatchObject({ theme: 'celebration', headline: 'Hooray', source: 'remembered' });
    const ctx = context();
    expect(() => previewStationery({ monogram: 'JMS' }, SENDER, ctx, 'pdf', 'botanical')).toThrow(
      'Initials print only on the monogram stationery.'
    );
  });

  it('says it is remembered when a remembered Monogram finds no initials in the name', () => {
    const { message, reason } = (() => {
      const ctx = context();
      try {
        previewStationery({}, '123 456', ctx, 'pdf', 'monogram');
      } catch (error) {
        return { message: (error as Error).message, reason: (vi.mocked(ctx.logger.warn).mock.calls[0][0] as unknown as { reason: string }).reason };
      }
      throw new Error('not refused');
    })();
    expect(message).toMatch(/^The account's remembered stationery is monogram\. The monogram stationery prints initials/);
    expect(reason).toBe('monogram_no_initials');
  });

  it('is nothing while stationery is not offered', () => {
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', '');
    expect(remembering({}, 'botanical')).toBeUndefined();
  });
});

describe('chooseStationery (#563 PR 5)', () => {
  it('reads the remembered theme only while offered and when the call asks for none', async () => {
    vi.mocked(rememberedStationery).mockResolvedValue('botanical');
    await expect(chooseStationery({}, SENDER, context(), 'pdf')).resolves.toMatchObject({ theme: 'botanical', source: 'remembered' });
    expect(rememberedStationery).toHaveBeenCalledWith('user-1');

    vi.mocked(rememberedStationery).mockClear();
    await expect(chooseStationery({ stationery: 'classic' }, SENDER, context(), 'pdf')).resolves.toEqual({ theme: 'classic', source: 'asked' });
    await expect(chooseStationery({}, SENDER, context(), 'html')).resolves.toBeUndefined();
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', '');
    await expect(chooseStationery({}, SENDER, context(), 'pdf')).resolves.toBeUndefined();
    expect(rememberedStationery).not.toHaveBeenCalled();
  });

  it('is Classic by default when nothing is remembered', async () => {
    vi.mocked(rememberedStationery).mockResolvedValue(null);
    await expect(chooseStationery({ stationery: '  ' }, SENDER, context(), 'pdf')).resolves.toEqual({ theme: 'classic', source: 'default' });
  });
});

describe("the name's titles and suffixes, where they stand (#570 review round 2)", () => {
  it('skips a title only at the start and a suffix only at the end', () => {
    for (const [name, initials] of [
      ['Md. Rafiqul Islam', 'MRI'],
      ['Pat Rivera, M.D.', 'PR'],
      ['Capt. Pat Rivera', 'PR'],
      ['Pat Rivera Snr', 'PR'],
      ['Rev. Dr. Martin Luther King Jr., PhD', 'MLK'],
      ['Ada Dr Lovelace', 'ADL']
    ]) {
      expect(offered({ stationery: 'monogram' }, name).monogram, name).toBe(initials);
    }
  });

  it('cleans asked-for initials as a slot prints them: any line break, and what prints nothing, go', () => {
    const nextLine = String.fromCodePoint(0x85);
    const zeroWidth = String.fromCodePoint(0x200b);
    expect(offered({ stationery: 'monogram', monogram: `J${nextLine}M` }).monogram).toBe('JM');
    expect(offered({ stationery: 'monogram', monogram: `J${zeroWidth}M` }).monogram).toBe('JM');
  });
});

/**
 * A letter preview drawn in a saved stationery design (#649): stationeryDesignId
 * in place of a theme, while designs are offered; the account's own design
 * only; a design's slots; and the remembered design before the remembered
 * theme.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/services/stationeryDefaultService.js', () => ({
  rememberedStationery: vi.fn(),
  rememberStationery: vi.fn()
}));
vi.mock('../../../src/services/stationeryDesignService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/stationeryDesignService.js')>()),
  getDesign: vi.fn(),
  rememberedDesign: vi.fn()
}));

import { chooseStationery, previewStationery } from '../../../src/tools/stationeryInput.js';
import { rememberedStationery } from '../../../src/services/stationeryDefaultService.js';
import { getDesign, rememberedDesign, type SavedDesign } from '../../../src/services/stationeryDesignService.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const NOW = new Date('2026-10-01T18:00:00Z');
const ID = '3f2b8c1e-9a4d-4c7e-8b1f-2d6a5e9c0b7a';
const SENDER = 'Pat Rivera';
const saved = (design: Partial<SavedDesign['design']> = {}, name = 'Garden'): SavedDesign => ({
  designId: ID,
  name,
  design: { face: 'handwritten', ornament: 'sprig', ruled: true, tone: 'medium', ...design },
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString()
});

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => NOW,
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}

/** previewStationery, refused: its message and the reason logged. */
function refused(input: Record<string, unknown>, asked: SavedDesign | null = null, remembered: SavedDesign | 'botanical' | null = null) {
  const ctx = context();
  let error: unknown;
  try {
    previewStationery(input, SENDER, ctx, 'pdf', remembered, asked);
  } catch (caught) {
    error = caught;
  }
  expect(error, JSON.stringify(input)).toBeInstanceOf(Error);
  expect((error as { diagnosticClass?: string }).diagnosticClass).toBe('validation_error');
  const [fields] = vi.mocked(ctx.logger.warn).mock.calls[0] as unknown as [{ reason: string }];
  return { message: (error as Error).message, reason: fields.reason };
}

function offerDesigns() {
  vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.stubEnv('LETTER_IRL_CUSTOM_STATIONERY_ENABLED', 'true');
}

beforeEach(() => {
  vi.mocked(rememberedStationery).mockReset().mockResolvedValue(null);
  vi.mocked(getDesign).mockReset().mockResolvedValue(null);
  vi.mocked(rememberedDesign).mockReset().mockResolvedValue(null);
  offerDesigns();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a saved design asked for (#649)', () => {
  it('draws the letter in it: the custom theme, its choices, its name and id, the date line', () => {
    const stationery = previewStationery({ stationeryDesignId: ID }, SENDER, context(), 'pdf', null, saved());
    expect(stationery).toEqual({
      theme: 'custom',
      design: { face: 'handwritten', ornament: 'sprig', ruled: true, tone: 'medium' },
      name: 'Garden',
      designId: ID,
      dateLine: 'October 1, 2026',
      source: 'asked'
    });
  });

  it('prints a headline on any design, and initials only with the monogram ornament', () => {
    expect(previewStationery({ stationeryDesignId: ID, headline: 'For Sam' }, SENDER, context(), 'pdf', null, saved())).toMatchObject({ headline: 'For Sam' });
    expect(previewStationery({ stationeryDesignId: ID }, SENDER, context(), 'pdf', null, saved({ ornament: 'monogram' }))).toMatchObject({ monogram: 'PR' });
    expect(previewStationery({ stationeryDesignId: ID, monogram: 'JMS' }, SENDER, context(), 'pdf', null, saved({ ornament: 'monogram' }))).toMatchObject({ monogram: 'JMS' });
    const { message, reason } = refused({ stationeryDesignId: ID, monogram: 'JMS' }, saved());
    expect(reason).toBe('monogram_without_theme');
    expect(message).toBe('Initials print only on a design whose ornament is the monogram, and this design has another. Leave monogram out, or choose a design or stationery that prints initials.');
  });

  it("says a design's missing initials in a design's words, and where it came from", () => {
    const missing = (remembered: boolean) => {
      try {
        previewStationery(remembered ? {} : { stationeryDesignId: ID }, '7 7', context(), 'pdf', remembered ? saved({ ornament: 'monogram' }) : null, remembered ? null : saved({ ornament: 'monogram' }));
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('not refused');
    };
    const words =
      "The saved stationery design prints initials, and the return address's name has none to use. " +
      'Pass monogram with one to three letters, such as "JMS", or choose another stationery.';
    expect(missing(false)).toBe(words);
    expect(missing(true)).toBe(`The account's remembered stationery is its saved design "Garden". ${words}`);
  });

  it('is refused with a theme too, as the account\'s none, or while designs are not offered', () => {
    expect(refused({ stationeryDesignId: ID, stationery: 'botanical' }, saved()).reason).toBe('design_with_theme');
    expect(refused({ stationeryDesignId: ID }, null).reason).toBe('design_not_found');
    expect(refused({ stationeryDesignId: ID.replace('3f', '4f') }, saved()).reason).toBe('design_not_found');
    expect(refused({ stationeryDesignId: 7 }, saved()).reason).toBe('stationeryDesignId_not_text');
    vi.stubEnv('LETTER_IRL_CUSTOM_STATIONERY_ENABLED', '');
    expect(refused({ stationeryDesignId: ID }, saved()).reason).toBe('design_not_offered');
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', '');
    expect(refused({ stationeryDesignId: ID }, saved()).reason).toBe('not_offered');
  });

  it('takes an empty id, or null, as none, as models send an unset field', () => {
    for (const none of ['', '   ', null]) {
      expect(previewStationery({ stationeryDesignId: none }, SENDER, context(), 'pdf')).toEqual({ theme: 'classic', source: 'default' });
    }
  });
});

describe('the remembered design (#649)', () => {
  it('draws a preview that names nothing, and says it was remembered, in the refusals too', () => {
    expect(previewStationery({}, SENDER, context(), 'pdf', saved())).toMatchObject({ theme: 'custom', name: 'Garden', source: 'remembered' });
    const { message } = refused({ monogram: 'JMS' }, null, saved());
    expect(message.startsWith('The account\'s remembered stationery is its saved design "Garden". ')).toBe(true);
  });

  it('gives way to a theme or a design the call names', () => {
    expect(previewStationery({ stationery: 'botanical' }, SENDER, context(), 'pdf', saved())).toMatchObject({ theme: 'botanical', source: 'asked' });
  });
});

describe('choosing the stationery (#649)', () => {
  it("reads the design asked for as the account's own", async () => {
    vi.mocked(getDesign).mockResolvedValue(saved());
    expect(await chooseStationery({ stationeryDesignId: ` ${ID} ` }, SENDER, context(), 'pdf')).toMatchObject({ theme: 'custom', designId: ID });
    expect(getDesign).toHaveBeenCalledWith('user-1', ID);
    expect(rememberedDesign).not.toHaveBeenCalled();
    expect(rememberedStationery).not.toHaveBeenCalled();
  });

  it('puts the remembered design before the remembered theme, and reads neither when the call names one', async () => {
    vi.mocked(rememberedDesign).mockResolvedValue(saved());
    vi.mocked(rememberedStationery).mockResolvedValue('botanical');
    expect(await chooseStationery({}, SENDER, context(), 'pdf')).toMatchObject({ theme: 'custom', source: 'remembered' });
    expect(rememberedStationery).not.toHaveBeenCalled();

    vi.mocked(rememberedDesign).mockResolvedValue(null);
    expect(await chooseStationery({}, SENDER, context(), 'pdf')).toMatchObject({ theme: 'botanical', source: 'remembered' });

    vi.mocked(rememberedDesign).mockClear();
    vi.mocked(rememberedStationery).mockClear();
    await chooseStationery({ stationery: 'typewriter' }, SENDER, context(), 'pdf');
    expect(rememberedDesign).not.toHaveBeenCalled();
    expect(rememberedStationery).not.toHaveBeenCalled();
  });

  it('reads no design while designs are not offered, and the remembered theme as before', async () => {
    vi.stubEnv('LETTER_IRL_CUSTOM_STATIONERY_ENABLED', '');
    vi.mocked(rememberedDesign).mockResolvedValue(saved());
    vi.mocked(rememberedStationery).mockResolvedValue('botanical');
    expect(await chooseStationery({}, SENDER, context(), 'pdf')).toMatchObject({ theme: 'botanical', source: 'remembered' });
    expect(rememberedDesign).not.toHaveBeenCalled();
    await expect(chooseStationery({ stationeryDesignId: ID }, SENDER, context(), 'pdf')).rejects.toThrow('Saved stationery designs are not available yet.');
    expect(getDesign).not.toHaveBeenCalled();
  });

  it("refuses a design that is not the account's", async () => {
    vi.mocked(getDesign).mockResolvedValue(null);
    await expect(chooseStationery({ stationeryDesignId: ID }, SENDER, context(), 'pdf')).rejects.toThrow('That stationery design was not found.');
  });
});

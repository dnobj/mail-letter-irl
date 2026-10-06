/**
 * The saved stationery design tools (#649): save_stationery_design,
 * list_stationery_designs and delete_stationery_design, each refusing while
 * designs are not offered, and saying in its own words what it did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/services/stationeryDesignService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/stationeryDesignService.js')>()),
  saveDesign: vi.fn(),
  listDesigns: vi.fn(),
  rememberedDesign: vi.fn(),
  deleteDesign: vi.fn()
}));

import { deleteDesign, listDesigns, rememberedDesign, saveDesign, type SavedDesign } from '../../../src/services/stationeryDesignService.js';
import { saveStationeryDesignTool } from '../../../src/tools/saveStationeryDesign.js';
import { listStationeryDesignsTool } from '../../../src/tools/listStationeryDesigns.js';
import { deleteStationeryDesignTool } from '../../../src/tools/deleteStationeryDesign.js';
import { deleteStationeryDesignOutputZ, listStationeryDesignsOutputZ, saveStationeryDesignOutputZ } from '../../../src/zodSchemas.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const ID = '3f2b8c1e-9a4d-4c7e-8b1f-2d6a5e9c0b7a';
const DESIGN = { face: 'handwritten', ornament: 'sprig', ruled: true, tone: 'medium' } as const;
const SAVED: SavedDesign = { designId: ID, name: 'Garden', design: DESIGN, createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z' };

function context(): ToolContext {
  return {
    user: { userId: 'user-1', creditsRemaining: 10 } as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-10-06T12:00:00Z'),
    persist: vi.fn(),
    isMobile: false
  } as unknown as ToolContext;
}
type Handler = (input: unknown, ctx: ToolContext) => Promise<Record<string, unknown>>;
const call = (tool: { handler: unknown }, input: Record<string, unknown>, ctx = context()) => (tool.handler as Handler)(input, ctx);

beforeEach(() => {
  vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.stubEnv('LETTER_IRL_CUSTOM_STATIONERY_ENABLED', 'true');
  vi.mocked(saveDesign).mockReset();
  vi.mocked(listDesigns).mockReset();
  vi.mocked(rememberedDesign).mockReset();
  vi.mocked(deleteDesign).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('save_stationery_design (#649)', () => {
  it('saves the name as a design name is kept, and the four choices, and says how to use it', async () => {
    vi.mocked(saveDesign).mockResolvedValue({ ok: true, saved: SAVED, replaced: false });
    const ctx = context();
    const result = await call(saveStationeryDesignTool, { name: '  Garden  ', ...DESIGN }, ctx);
    expect(saveDesign).toHaveBeenCalledWith('user-1', 'Garden', DESIGN);
    expect(result).toEqual({
      designId: ID,
      name: 'Garden',
      ...DESIGN,
      replaced: false,
      message:
        'Saved the design. Draw a letter in it with stationeryDesignId on a letter preview or set_stationery; letters already previewed keep their own. It prints in black and greys, as every letter does.'
    });
    expect(saveStationeryDesignOutputZ.safeParse(result).success).toBe(true);
    // The log has the choices, never the name.
    expect(JSON.stringify(vi.mocked(ctx.logger.info).mock.calls)).not.toContain('Garden');
  });

  it('says when it replaced the design of that name', async () => {
    vi.mocked(saveDesign).mockResolvedValue({ ok: true, saved: SAVED, replaced: true });
    const result = await call(saveStationeryDesignTool, { name: 'GARDEN', ...DESIGN });
    expect(result.replaced).toBe(true);
    expect(String(result.message).startsWith('Replaced the saved design of that name. ')).toBe(true);
  });

  it('refuses a name that keeps nothing visible, or too long, before saving anything', async () => {
    for (const name of ['', '   ', String.fromCodePoint(0x200d), 'x'.repeat(41), 7]) {
      await expect(call(saveStationeryDesignTool, { name, ...DESIGN }), String(name)).rejects.toMatchObject({ code: 'DESIGN_NAME_INVALID' });
    }
    expect(saveDesign).not.toHaveBeenCalled();
  });

  it('refuses a choice the renderer does not draw, as a direct call may send one', async () => {
    for (const choice of [{ face: 'script' }, { ornament: 'border' }, { tone: 'red' }, { ruled: 'yes' }]) {
      await expect(call(saveStationeryDesignTool, { name: 'Garden', ...DESIGN, ...choice }), JSON.stringify(choice)).rejects.toMatchObject({
        code: 'DESIGN_CHOICE_INVALID'
      });
    }
    expect(saveDesign).not.toHaveBeenCalled();
  });

  it('says the limit and the ways round it, and refuses an erased account', async () => {
    vi.mocked(saveDesign).mockResolvedValue({ ok: false, refusal: 'limit' });
    await expect(call(saveStationeryDesignTool, { name: 'Garden', ...DESIGN })).rejects.toMatchObject({
      code: 'DESIGN_LIMIT',
      message:
        'This account has 10 saved designs, the most it may keep. Delete one the person no longer wants (delete_stationery_design), or save under the name of one to replace it.'
    });
    vi.mocked(saveDesign).mockResolvedValue({ ok: false, refusal: 'account_closed' });
    await expect(call(saveStationeryDesignTool, { name: 'Garden', ...DESIGN })).rejects.toMatchObject({ code: 'ACCOUNT_CLOSED' });
  });
});

describe('list_stationery_designs (#649)', () => {
  it("lists the account's designs flat, the remembered one, and the limit", async () => {
    vi.mocked(listDesigns).mockResolvedValue([SAVED, { ...SAVED, designId: ID.replace('3f', '4f'), name: 'Plain' }]);
    vi.mocked(rememberedDesign).mockResolvedValue(SAVED);
    const result = await call(listStationeryDesignsTool, {});
    expect(result).toEqual({
      designs: [
        { designId: ID, name: 'Garden', ...DESIGN },
        { designId: ID.replace('3f', '4f'), name: 'Plain', ...DESIGN }
      ],
      rememberedDesignId: ID,
      limit: 10,
      message: '2 saved stationery designs. Draw a letter in one with its designId as stationeryDesignId.'
    });
    expect(listStationeryDesignsOutputZ.safeParse(result).success).toBe(true);
  });

  it('says none is saved, without a remembered one', async () => {
    vi.mocked(listDesigns).mockResolvedValue([]);
    vi.mocked(rememberedDesign).mockResolvedValue(null);
    const result = await call(listStationeryDesignsTool, {});
    expect(result).toEqual({
      designs: [],
      limit: 10,
      message: 'No stationery designs are saved. save_stationery_design saves one the person describes.'
    });
    vi.mocked(listDesigns).mockResolvedValue([SAVED]);
    expect((await call(listStationeryDesignsTool, {})).message).toBe('1 saved stationery design. Draw a letter in one with its designId as stationeryDesignId.');
  });
});

describe('delete_stationery_design (#649)', () => {
  it('deletes only once the person has confirmed, and says whether there was one', async () => {
    await expect(call(deleteStationeryDesignTool, { designId: ID, confirm: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    expect(deleteDesign).not.toHaveBeenCalled();
    vi.mocked(deleteDesign).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deleted = await call(deleteStationeryDesignTool, { designId: ` ${ID} `, confirm: true });
    expect(deleteDesign).toHaveBeenCalledWith('user-1', ID);
    expect(deleted).toEqual({ deleted: true, message: 'Deleted the design. Letters already previewed or sent keep theirs.' });
    expect(deleteStationeryDesignOutputZ.safeParse(deleted).success).toBe(true);
    expect(await call(deleteStationeryDesignTool, { designId: ID, confirm: true })).toEqual({
      deleted: false,
      message: "The account has no design with that designId, so nothing changed. list_stationery_designs lists the account's designs."
    });
  });
});

describe('the design tools while designs are not offered (#649)', () => {
  it.each([
    ['the flag is off', { LETTER_IRL_CUSTOM_STATIONERY_ENABLED: '' }],
    ['stationery is off', { LETTER_IRL_STATIONERY_ENABLED: '' }],
    ['the renderer is not ours', { LETTER_IRL_PRINT_RENDERER: 'html' }]
  ])('each refuses when %s, touching nothing', async (_name, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    await expect(call(saveStationeryDesignTool, { name: 'Garden', ...DESIGN })).rejects.toMatchObject({ code: 'DESIGNS_OFF' });
    await expect(call(listStationeryDesignsTool, {})).rejects.toMatchObject({ code: 'DESIGNS_OFF' });
    await expect(call(deleteStationeryDesignTool, { designId: ID, confirm: true })).rejects.toMatchObject({ code: 'DESIGNS_OFF' });
    expect(saveDesign).not.toHaveBeenCalled();
    expect(listDesigns).not.toHaveBeenCalled();
    expect(deleteDesign).not.toHaveBeenCalled();
  });
});

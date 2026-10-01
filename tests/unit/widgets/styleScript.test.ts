/**
 * widgets/shared/style.js (#563): the letter card's Style row, on its own.
 * It runs inside the card in letterPreviewCardStyle.test.ts; here are the
 * cases a card in a test host does not reach: a host that cannot call tools,
 * a card that is not idle, and a new draft.
 */

import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../widgets/shared/style.js'), 'utf-8');

const ROW = `
  <div id="row" style="display: none">
    <button data-theme="classic"></button><button data-theme="monogram"></button>
    <button data-theme="botanical"></button><button data-theme="celebration"></button>
  </div>
  <div id="note" style="display: none"></div>`;

function load(host: Record<string, unknown>, idle: () => boolean = () => true) {
  const dom = new JSDOM(`<body>${ROW}<script>${SOURCE}</script></body>`, { runScripts: 'dangerously' });
  const window = dom.window as any;
  const document = window.document as Document;
  const changes: unknown[] = [];
  const row = window.letterIrlStyle.createStyle({
    host,
    row: document.getElementById('row'),
    buttons: Array.from(document.querySelectorAll('[data-theme]')),
    note: document.getElementById('note'),
    readableError: (error: Error) => error.message,
    resultText: () => 'refused',
    idle,
    onSet: () => undefined,
    onChange: (change: unknown) => changes.push(change),
    onBusy: () => undefined
  });
  const click = (theme: string) => document.querySelector(`[data-theme="${theme}"]`)!.dispatchEvent(new window.Event('click'));
  return { window, document, row, click, changes, shown: () => document.getElementById('row')!.style.display !== 'none' };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const answer = (stationery: Record<string, unknown>, previewHtml = '<html>page</html>') => ({
  structuredContent: { draftId: 'draft-1', stationery },
  _meta: { previewHtml }
});

describe('the Style row script (#563)', () => {
  it('lists the four themes', () => {
    const { window } = load({ callTool: vi.fn() });
    expect(window.letterIrlStyle.THEMES).toEqual(['classic', 'monogram', 'botanical', 'celebration']);
  });

  it('is hidden where the host cannot call tools, or for a stationery it does not know', () => {
    const noCalls = load({});
    noCalls.row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    expect(noCalls.shown()).toBe(false);

    const unknown = load({ callTool: vi.fn() });
    unknown.row.show('draft-1', { stationery: { theme: 'typewriter' } }, true);
    expect(unknown.shown()).toBe(false);
    unknown.row.show('draft-1', { stationery: { theme: 'classic' } }, false);
    expect(unknown.shown()).toBe(false);
  });

  it('sets nothing while the card is not idle, nor a theme it does not know', async () => {
    const callTool = vi.fn();
    let idle = false;
    const { row, click } = load({ callTool }, () => idle);
    row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    click('botanical');
    await flush();
    expect(callTool).not.toHaveBeenCalled();

    idle = true;
    const { row: other, document, window } = load({ callTool });
    other.show('draft-1', { stationery: { theme: 'classic' } }, true);
    const stray = document.createElement('button');
    stray.setAttribute('data-theme', 'typewriter');
    document.getElementById('row')!.appendChild(stray);
    stray.dispatchEvent(new window.Event('click'));
    await flush();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("keeps the page it set for its own draft only, and starts afresh with a new draft's own", async () => {
    const callTool = vi.fn().mockResolvedValue(answer({ theme: 'celebration', headline: 'Hooray', dateLine: 'October 1, 2026' }, '<html>themed</html>'));
    const { row, click, changes } = load({ callTool });
    row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    click('celebration');
    await flush();
    await flush();
    expect(row.previewHtml('draft-1')).toBe('<html>themed</html>');
    expect(row.previewHtml('draft-2')).toBeNull();
    expect(changes).toEqual([{ draftId: 'draft-1', stationery: { theme: 'celebration', headline: 'Hooray', dateLine: 'October 1, 2026' } }]);

    // Another draft: its own preview's page and style, and none of the first's slots.
    row.show('draft-2', { stationery: { theme: 'botanical' } }, true);
    expect(row.previewHtml('draft-2')).toBeNull();
    expect(row.stationery()).toEqual({ theme: 'botanical' });
    click('celebration');
    await flush();
    expect(callTool).toHaveBeenLastCalledWith('set_stationery', { draftId: 'draft-2', stationery: 'celebration' });
  });

  it("drops an answer for a draft it has moved on from", async () => {
    let settle: (value: unknown) => void = () => undefined;
    const callTool = vi.fn().mockReturnValue(new Promise(resolve => { settle = resolve; }));
    const { row, click, changes } = load({ callTool });
    row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    click('botanical');
    await flush();
    row.show('draft-2', { stationery: { theme: 'classic' } }, true);
    settle(answer({ theme: 'botanical' }));
    await flush();
    await flush();
    expect(changes).toEqual([]);
    expect(row.previewHtml('draft-1')).toBeNull();
    expect(row.stationery()).toEqual({ theme: 'classic' });
    expect(row.busy()).toBe(false);
  });
});

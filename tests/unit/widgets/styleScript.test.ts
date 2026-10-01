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

/** The row as a card builds it; `extra` adds buttons before the script wires them. */
function load(host: Record<string, unknown>, idle: () => boolean = () => true, extra = '') {
  const dom = new JSDOM(`<body>${ROW.replace('</div>', `${extra}</div>`)}<script>${SOURCE}</script></body>`, {
    runScripts: 'dangerously'
  });
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
    // A button the card names with a theme the script does not know.
    const { row: other, click: press } = load({ callTool }, () => true, '<button data-theme="typewriter"></button>');
    other.show('draft-1', { stationery: { theme: 'classic' } }, true);
    press('typewriter');
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
    // A theme unlike both, so taking the answer would show.
    row.show('draft-2', { stationery: { theme: 'monogram' } }, true);
    settle(answer({ theme: 'botanical' }));
    await flush();
    await flush();
    expect(changes).toEqual([]);
    expect(row.previewHtml('draft-1')).toBeNull();
    expect(row.stationery()).toEqual({ theme: 'monogram' });
    expect(row.busy()).toBe(false);
  });
});

describe('the Style row script, held and adopting (#572 review round 1)', () => {
  it('holds while the card sends, saying so, and ignores a press meanwhile', async () => {
    const callTool = vi.fn().mockResolvedValue(answer({ theme: 'botanical' }));
    const { row, click, document } = load({ callTool });
    row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    row.hold(true);
    expect(document.querySelector('[data-theme="botanical"]')!.getAttribute('aria-disabled')).toBe('true');
    click('botanical');
    await flush();
    expect(callTool).not.toHaveBeenCalled();
    row.hold(false);
    expect(document.querySelector('[data-theme="botanical"]')!.getAttribute('aria-disabled')).toBe('false');
    click('botanical');
    await flush();
    expect(callTool).toHaveBeenCalledWith('set_stationery', { draftId: 'draft-1', stationery: 'botanical' });
  });

  it('does not draw a hidden row when held, so its note stays hidden', async () => {
    // A refusal leaves a note under the row.
    const callTool = vi.fn().mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'No.' }] });
    const { row, click, document } = load({ callTool });
    row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    click('botanical');
    await flush();
    await flush();
    expect(document.getElementById('note')!.style.display).toBe('block');

    row.hide();
    row.hold(false);
    expect(document.getElementById('row')!.style.display).toBe('none');
    expect(document.getElementById('note')!.style.display).toBe('none');
  });

  it("adopts the draft's style and page for its own draft, and takes nothing otherwise", () => {
    const { row } = load({ callTool: vi.fn() });
    row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    expect(row.adopt('draft-2', { theme: 'botanical' }, '<html>other</html>')).toBe(false);
    expect(row.adopt('draft-1', { theme: 'typewriter' }, '<html>x</html>')).toBe(false);
    expect(row.adopt('draft-1', null, '<html>x</html>')).toBe(false);
    expect(row.stationery()).toEqual({ theme: 'classic' });

    expect(row.adopt('draft-1', { theme: 'celebration', headline: 'Hooray' }, '<html>now</html>')).toBe(true);
    expect(row.stationery()).toEqual({ theme: 'celebration', headline: 'Hooray' });
    expect(row.previewHtml('draft-1')).toBe('<html>now</html>');
    // A style without its page keeps the page it has.
    expect(row.adopt('draft-1', { theme: 'monogram' }, undefined)).toBe(true);
    expect(row.previewHtml('draft-1')).toBe('<html>now</html>');
  });

  it('takes nothing while it sets a style itself', async () => {
    const callTool = vi.fn().mockReturnValue(new Promise(() => undefined));
    const { row, click } = load({ callTool });
    row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    click('botanical');
    await flush();
    expect(row.adopt('draft-1', { theme: 'celebration' }, '<html>x</html>')).toBe(false);
  });
});

describe('the Style row script, after its own restyle (#572 review round 2)', () => {
  it("takes no status answer once it has set a style on the draft: that answer is older", async () => {
    const callTool = vi.fn().mockResolvedValue(answer({ theme: 'botanical', dateLine: 'October 1, 2026' }, '<html>botanical</html>'));
    const { row, click } = load({ callTool });
    row.show('draft-1', { stationery: { theme: 'classic' } }, true);
    click('botanical');
    await flush();
    await flush();
    expect(row.stationery()).toEqual({ theme: 'botanical', dateLine: 'October 1, 2026' });

    // The status answer the card asked for at its first render, landing late.
    expect(row.adopt('draft-1', { theme: 'classic' }, '<html>classic</html>')).toBe(false);
    expect(row.stationery()).toEqual({ theme: 'botanical', dateLine: 'October 1, 2026' });
    expect(row.previewHtml('draft-1')).toBe('<html>botanical</html>');

    // Another draft starts afresh.
    row.show('draft-2', { stationery: { theme: 'classic' } }, true);
    expect(row.adopt('draft-2', { theme: 'monogram' }, '<html>monogram</html>')).toBe(true);
  });
});

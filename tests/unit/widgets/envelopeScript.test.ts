/**
 * widgets/shared/envelope.js (#576): the letter card's envelope reveal, on
 * its own. It runs inside the card in letterPreviewCardEnvelope.test.ts; here
 * are its states, its envelope and the cases a card in a test host does not
 * reach: an animation that never ends, and a draft moved on from.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../widgets/shared/envelope.js'), 'utf-8');

/** A page view as the card builds it, the script loaded; `still` turns on reduced motion. */
function load(options: { enabled?: boolean; still?: boolean } = {}) {
  const timers: Array<() => void> = [];
  const dom = new JSDOM('<body><div id="container"></div></body>', {
    runScripts: 'outside-only',
    beforeParse(window) {
      (window as any).matchMedia = (query: string) => ({ matches: !!options.still && query.includes('reduce') });
    }
  });
  const window = dom.window as any;
  window.setTimeout = (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  };
  window.eval(SOURCE);
  const document = window.document as Document;
  let enabled = options.enabled ?? true;
  const envelope = window.letterIrlEnvelope.createEnvelope({ win: window, enabled: () => enabled });
  const draw = () => {
    const container = document.getElementById('container')!;
    container.textContent = '';
    const view = document.createElement('div');
    view.className = 'letter-page-view';
    const page = document.createElement('div');
    page.className = 'letter-page';
    page.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    view.appendChild(page);
    container.appendChild(view);
    return { view, page };
  };
  const ended = (page: Element) => page.parentElement!.dispatchEvent(Object.assign(new window.Event('animationend', { bubbles: true }), {}));
  return {
    window,
    envelope,
    draw,
    timers,
    end: (page: Element) => page.dispatchEvent(new window.Event('animationend', { bubbles: true })),
    ended,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    classes: (view: Element) => [...view.classList].filter(name => name.startsWith('envelope-')),
    drawn: (page: Element) => page.querySelector(':scope > svg.envelope')
  };
}

describe('the envelope reveal script (#576)', () => {
  it('names the meta key the previews set', () => {
    expect(load().window.letterIrlEnvelope.ENVELOPE_META).toBe('letter-irl/envelopeReveal');
  });

  it('draws a window envelope over the page\'s top third: two windows at the addresses, a stamp, hidden from screen readers', () => {
    const { envelope, draw, drawn } = load();
    const { view, page } = draw();
    envelope.dress(view, page, 'draft-1');
    const svg = drawn(page)!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 612 264');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const [sheet, stamp] = [...svg.querySelectorAll('path')];
    expect(sheet.getAttribute('fill-rule')).toBe('evenodd');
    // The sheet and its two windows, every part a closed rectangle.
    const rects = sheet.getAttribute('d')!.match(/M[\d.]+ [\d.]+H[\d.]+V[\d.]+H[\d.]+Z/g)!;
    expect(rects).toHaveLength(3);
    expect(sheet.getAttribute('d')).toContain('M43 22H266V101H43Z');
    expect(sheet.getAttribute('d')).toContain('M43 115H266V198H43Z');
    expect(stamp.getAttribute('fill')).toBe('none');
  });

  it('opens a draft\'s page the first time it shows, then never again', () => {
    const { envelope, draw, end, classes, drawn } = load();
    let { view, page } = draw();
    envelope.dress(view, page, 'draft-1');
    expect(classes(view)).toEqual(['envelope-opening']);
    expect(drawn(page)).not.toBeNull();
    end(page);
    expect(classes(view)).toEqual([]);
    expect(drawn(page)).toBeNull();
    // A redraw shows the page as it is.
    ({ view, page } = draw());
    envelope.dress(view, page, 'draft-1');
    expect(classes(view)).toEqual([]);
    expect(drawn(page)).toBeNull();
    // Another draft opens once too.
    ({ view, page } = draw());
    envelope.dress(view, page, 'draft-2');
    expect(classes(view)).toEqual(['envelope-opening']);
  });

  it('settles even when the host never ends the animation', () => {
    const { envelope, draw, timers, classes } = load();
    const { view, page } = draw();
    envelope.dress(view, page, 'draft-1');
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(classes(view)).toEqual([]);
  });

  it('ignores an animation that ends on the envelope rather than the page', () => {
    const { window, envelope, draw, classes, drawn } = load();
    const { view, page } = draw();
    envelope.dress(view, page, 'draft-1');
    drawn(page)!.dispatchEvent(new window.Event('animationend', { bubbles: true }));
    expect(classes(view)).toEqual(['envelope-opening']);
  });

  it('does nothing while off, or without a draft', () => {
    const { envelope, draw, classes, drawn } = load({ enabled: false });
    const { view, page } = draw();
    envelope.dress(view, page, 'draft-1');
    envelope.seal('draft-1');
    expect(classes(view)).toEqual([]);
    expect(drawn(page)).toBeNull();
    const on = load();
    const drawnOn = on.draw();
    on.envelope.dress(drawnOn.view, drawnOn.page, null);
    expect(on.classes(drawnOn.view)).toEqual([]);
  });

  it('folds a sent letter in, and keeps it sealed through redraws until a press shows it', () => {
    const { envelope, draw, end, classes, drawn } = load();
    let { view, page } = draw();
    envelope.dress(view, page, 'draft-1');
    end(page);
    envelope.seal('draft-1');
    expect(classes(view)).toEqual(['envelope-sealing']);
    expect(drawn(page)).not.toBeNull();
    end(page);
    expect(classes(view)).toEqual(['envelope-sealed']);
    expect(envelope.sealed('draft-1')).toBe(true);
    expect(envelope.sealed('draft-2')).toBe(false);
    // A host redraw keeps it sealed, without moving.
    ({ view, page } = draw());
    envelope.dress(view, page, 'draft-1');
    expect(classes(view)).toEqual(['envelope-sealed']);
    expect(drawn(page)).not.toBeNull();
    envelope.unseal();
    expect(classes(view)).toEqual([]);
    expect(drawn(page)).toBeNull();
    expect(envelope.sealed('draft-1')).toBe(false);
    // Shown, it stays shown on a redraw.
    ({ view, page } = draw());
    envelope.dress(view, page, 'draft-1');
    expect(classes(view)).toEqual([]);
  });

  it('seals mid-opening, without the opening finishing it', () => {
    const { envelope, draw, end, classes } = load();
    const { view, page } = draw();
    envelope.dress(view, page, 'draft-1');
    envelope.seal('draft-1');
    expect(classes(view)).toEqual(['envelope-sealing']);
    end(page);
    expect(classes(view)).toEqual(['envelope-sealed']);
  });

  it('moves nothing with reduced motion: the page shows at once, and a sent letter is sealed at once', () => {
    const { envelope, draw, timers, classes, drawn } = load({ still: true });
    const { view, page } = draw();
    envelope.dress(view, page, 'draft-1');
    expect(classes(view)).toEqual([]);
    expect(drawn(page)).toBeNull();
    envelope.seal('draft-1');
    expect(classes(view)).toEqual(['envelope-sealed']);
    expect(drawn(page)).not.toBeNull();
    expect(timers).toHaveLength(0);
  });
});

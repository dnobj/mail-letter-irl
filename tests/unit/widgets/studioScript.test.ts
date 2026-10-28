/**
 * widgets/shared/studio.js (#580): the studio layout, on its own. It runs
 * inside the letter card in letterPreviewCardStudio.test.ts; here are its
 * slots, its switch and its tabs with a skeleton of the test's own.
 */

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../../widgets/shared/studio.js'), 'utf-8');

const PAGE = `
  <div id="card"><div class="rows"><div id="first">First</div><div id="second">Second</div></div></div>
  <template id="skeleton">
    <div class="tabs">
      <div class="studio-tabs">
        <button role="tab" data-tab="one" id="tab-one">One</button>
        <button role="tab" data-tab="two" id="tab-two">Two</button>
      </div>
      <div role="tabpanel" data-tab="one"><span data-slot="first"></span><span data-slot="missing"></span></div>
      <div role="tabpanel" data-tab="two" hidden><span data-slot="second"></span></div>
    </div>
  </template>`;

function load() {
  const dom = new JSDOM(`<body>${PAGE}</body>`, { runScripts: 'outside-only' });
  const window = dom.window as any;
  window.eval(SOURCE);
  const document = window.document as Document;
  let enabled = false;
  const studio = window.letterIrlStudio.createStudio({
    card: document.getElementById('card'),
    template: document.getElementById('skeleton'),
    enabled: () => enabled
  });
  return {
    window,
    document,
    studio,
    turnOn: () => {
      enabled = true;
    },
    turnOff: () => {
      enabled = false;
    },
    selected: () =>
      Array.from(document.querySelectorAll('[role="tab"]'))
        .filter(tab => tab.getAttribute('aria-selected') === 'true')
        .map(tab => tab.getAttribute('data-tab')),
    shown: () =>
      Array.from(document.querySelectorAll('[role="tabpanel"]'))
        .filter(panel => !(panel as HTMLElement).hidden)
        .map(panel => panel.getAttribute('data-tab'))
  };
}

describe('widgets/shared/studio.js (#580)', () => {
  it('names its switch', () => {
    expect(load().window.letterIrlStudio.STUDIO_META).toBe('letterirl/studioCard');
  });

  it('does nothing until the switch is on', () => {
    const page = load();
    expect(page.studio.update()).toBe(false);
    expect(page.studio.on()).toBe(false);
    expect(page.document.getElementById('card')!.classList.contains('studio')).toBe(false);
    expect(page.document.getElementById('first')!.parentElement!.className).toBe('rows');
    // Selecting before the layout exists is harmless.
    page.studio.select('two');
    page.studio.suggest('two');
    expect(page.selected()).toEqual([]);
  });

  it("lays the card out once: each slot takes the card's element, and a slot without one is dropped", () => {
    const page = load();
    page.turnOn();
    expect(page.studio.update()).toBe(true);
    const card = page.document.getElementById('card')!;
    expect(card.classList.contains('studio')).toBe(true);
    expect(card.firstElementChild!.className).toBe('tabs');
    expect(page.document.getElementById('first')!.parentElement!.getAttribute('data-tab')).toBe('one');
    expect(page.document.getElementById('second')!.parentElement!.getAttribute('data-tab')).toBe('two');
    expect(page.document.querySelectorAll('[data-slot]')).toHaveLength(0);
    expect(card.querySelector('.rows')!.children).toHaveLength(0);

    page.turnOff();
    expect(page.studio.update()).toBe(true);
    page.turnOn();
    page.studio.update();
    expect(page.document.querySelectorAll('.tabs')).toHaveLength(1);
  });

  it('starts on the first tab, and shows only its panel', () => {
    const page = load();
    page.turnOn();
    page.studio.update();
    expect(page.selected()).toEqual(['one']);
    expect(page.shown()).toEqual(['one']);
    expect(page.studio.selected()).toBe('one');
    page.studio.select('two');
    expect(page.selected()).toEqual(['two']);
    expect(page.shown()).toEqual(['two']);
    page.studio.select('nowhere');
    expect(page.selected()).toEqual(['two']);
  });

  it("suggests a tab only until the person picks one", () => {
    const page = load();
    page.turnOn();
    page.studio.update();
    page.studio.suggest('two');
    expect(page.selected()).toEqual(['two']);
    page.studio.suggest('one');
    expect(page.selected()).toEqual(['one']);

    page.document.getElementById('tab-two')!.dispatchEvent(new page.window.Event('click'));
    expect(page.selected()).toEqual(['two']);
    page.studio.suggest('one');
    expect(page.selected()).toEqual(['two']);
    // A select is the card's own, and still applies.
    page.studio.select('one');
    expect(page.selected()).toEqual(['one']);
  });

  it('counts an arrow key as a pick, and moves focus with it', () => {
    const page = load();
    page.turnOn();
    page.studio.update();
    const one = page.document.getElementById('tab-one')!;
    one.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(page.selected()).toEqual(['two']);
    expect(page.document.activeElement).toBe(page.document.getElementById('tab-two'));
    page.studio.suggest('one');
    expect(page.selected()).toEqual(['two']);
  });
});

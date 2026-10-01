/**
 * Inlining the card host bridge (src/mcp/widgetHost.ts, #474): a card marks
 * the spot, and the server puts widgets/shared/host.js there in a script tag.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_BRIDGE_PLACEHOLDER, inlineHostBridge, PAGES_PLACEHOLDER } from '../../../src/mcp/widgetHost.js';

const WIDGET_DIR = path.resolve(__dirname, '../../../widgets');
const temporaryDirs: string[] = [];

/** A widget directory whose bridge says `source`. */
function widgetDirWithBridge(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lirl-bridge-'));
  fs.mkdirSync(path.join(dir, 'shared'));
  fs.writeFileSync(path.join(dir, 'shared', 'host.js'), source);
  temporaryDirs.push(dir);
  return dir;
}

/** A widget directory with these shared scripts. */
function widgetDirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lirl-shared-'));
  fs.mkdirSync(path.join(dir, 'shared'));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'shared', name), source);
  temporaryDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('inlining the card host bridge', () => {
  it('serves a card without the marker unchanged', () => {
    const html = '<html><body><script>window.openai</script></body></html>';
    expect(inlineHostBridge(html, WIDGET_DIR)).toBe(html);
  });

  it('puts the bridge where the card asks, once, in a script tag', () => {
    const html = `<html><body>${HOST_BRIDGE_PLACEHOLDER}<script>render()</script></body></html>`;
    const served = inlineHostBridge(html, WIDGET_DIR);
    const bridge = fs.readFileSync(path.join(WIDGET_DIR, 'shared', 'host.js'), 'utf-8');
    expect(served).not.toContain(HOST_BRIDGE_PLACEHOLDER);
    expect(served).toContain(`<script>\n${bridge}\n    </script><script>render()</script>`);
    expect(served.split(bridge).length - 1).toBe(1);
  });

  it('keeps a $ in the bridge as written', () => {
    const dir = widgetDirWithBridge('var price = "$&"; var all = "$$";');
    expect(inlineHostBridge(`<body>${HOST_BRIDGE_PLACEHOLDER}</body>`, dir)).toContain('var price = "$&"; var all = "$$";');
  });

  it('refuses a bridge that would end the script tag early', () => {
    const dir = widgetDirWithBridge('var s = "</script>";');
    expect(() => inlineHostBridge(`<body>${HOST_BRIDGE_PLACEHOLDER}</body>`, dir)).toThrow('closing script tag');
  });

  it('refuses a bridge that carries the marker itself', () => {
    const dir = widgetDirWithBridge(`// ${HOST_BRIDGE_PLACEHOLDER}`);
    expect(() => inlineHostBridge(`<body>${HOST_BRIDGE_PLACEHOLDER}</body>`, dir)).toThrow('marker comment');
  });
});

describe("inlining the renderer's pages (#534)", () => {
  it('puts widgets/shared/pages.js where a card asks, after the bridge, each once', () => {
    const html = `<html><body>${HOST_BRIDGE_PLACEHOLDER}${PAGES_PLACEHOLDER}<script>render()</script></body></html>`;
    const served = inlineHostBridge(html, WIDGET_DIR);
    const bridge = fs.readFileSync(path.join(WIDGET_DIR, 'shared', 'host.js'), 'utf-8');
    const pages = fs.readFileSync(path.join(WIDGET_DIR, 'shared', 'pages.js'), 'utf-8');
    expect(served).not.toContain(PAGES_PLACEHOLDER);
    expect(served).toContain(`<script>\n${bridge}\n    </script><script>\n${pages}\n    </script><script>render()</script>`);
    expect(served.split(pages).length - 1).toBe(1);
  });

  it('serves the pages alone to a card that asks for them alone', () => {
    const dir = widgetDirWith({ 'pages.js': 'window.letterIrlPages = {};' });
    expect(inlineHostBridge(`<body>${PAGES_PLACEHOLDER}</body>`, dir)).toBe('<body><script>\nwindow.letterIrlPages = {};\n    </script></body>');
  });

  it('refuses a pages script that would end its tag early, or carries a marker', () => {
    expect(() => inlineHostBridge(`<body>${PAGES_PLACEHOLDER}</body>`, widgetDirWith({ 'pages.js': 'var s = "</script>";' })))
      .toThrow('widgets/shared/pages.js must not contain a closing script tag');
    expect(() => inlineHostBridge(`<body>${PAGES_PLACEHOLDER}</body>`, widgetDirWith({ 'pages.js': `// ${HOST_BRIDGE_PLACEHOLDER}` })))
      .toThrow('widgets/shared/pages.js must not contain the card\'s marker comment');
  });

  it('refuses a shared script that opens an HTML comment, which could keep its tag from closing', () => {
    expect(() => inlineHostBridge(`<body>${PAGES_PLACEHOLDER}</body>`, widgetDirWith({ 'pages.js': 'var s = "<!--<script ";' })))
      .toThrow('widgets/shared/pages.js must not contain an HTML comment opener');
    expect(() => inlineHostBridge(`<body>${HOST_BRIDGE_PLACEHOLDER}</body>`, widgetDirWith({ 'host.js': 'var s = "<!--";' })))
      .toThrow('widgets/shared/host.js must not contain an HTML comment opener');
  });

  it('is asked for by both preview cards', () => {
    for (const card of ['LetterPreviewCard', 'PostcardPreviewCard']) {
      const html = fs.readFileSync(path.join(WIDGET_DIR, `${card}.html`), 'utf-8');
      expect(html.split(PAGES_PLACEHOLDER).length - 1, card).toBe(1);
      expect(html, card).toContain('window.letterIrlPages');
    }
  });
});

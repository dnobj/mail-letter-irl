/**
 * Inlining the card host bridge (src/mcp/widgetHost.ts, #474): a card marks
 * the spot, and the server puts widgets/shared/host.js there in a script tag.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_BRIDGE_PLACEHOLDER, inlineHostBridge } from '../../../src/mcp/widgetHost.js';

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

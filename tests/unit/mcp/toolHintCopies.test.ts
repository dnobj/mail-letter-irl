import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientProfileNamed } from '../../../src/auth/clientProfiles.js';
import { buildAnnotations } from '../../../src/mcp/registerTools.js';
import { isToolOffered } from '../../../src/mcp/toolCatalog.js';
import * as tools from '../../../src/tools/index.js';

/**
 * A tool's annotations come from buildAnnotations(), the one place the hints
 * are decided (docs/app-submission/openai-test-cases.md). Some tools also
 * carry the hints in their _meta, which is served beside them: a copy there
 * must say what the annotations say, or a host reading one and a reviewer the
 * other see two different tools.
 */

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

type Definition = { name: string; readOnly: boolean; meta?: Record<string, unknown> };

const definitions = (Object.values(tools) as unknown[]).filter(
  (value): value is Definition =>
    typeof value === 'object' && value !== null && typeof (value as Definition).name === 'string' && 'handler' in value
);

describe("the hints a tool's _meta copies (launch submission)", () => {
  it('finds the tools', () => {
    expect(definitions.length).toBeGreaterThan(30);
  });

  it.each(definitions.map((tool) => [tool.name, tool] as const))('%s copies its annotations exactly, where it copies them', (_name, tool) => {
    const annotations = buildAnnotations(tool) as Record<string, unknown>;
    for (const hint of HINTS) {
      if (tool.meta && hint in tool.meta) expect(tool.meta[hint], hint).toBe(annotations[hint]);
    }
  });
});

describe('the hints and listing the launch submission names', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('marks set_postcard_style open world: on a new size it fetches the picture again from its link', () => {
    expect(buildAnnotations({ name: 'set_postcard_style', readOnly: false }).openWorldHint).toBe(true);
  });

  it('lists upload_photo_chunk only where the card sends the photo itself, never in ChatGPT', () => {
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', 'true');
    expect(isToolOffered('upload_photo_chunk', clientProfileNamed('claude'))).toBe(true);
    expect(isToolOffered('upload_photo_chunk', clientProfileNamed('chatgpt'))).toBe(false);
    vi.stubEnv('LETTER_IRL_CARD_UPLOAD_ENABLED', '');
    expect(isToolOffered('upload_photo_chunk', clientProfileNamed('claude'))).toBe(false);
  });
});

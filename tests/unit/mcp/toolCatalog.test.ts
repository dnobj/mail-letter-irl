import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as toolDefinitions from '../../../src/tools/index.js';
import {
  APP_ONLY_TOOLS,
  CARD_ONLY_SEND_TOOLS,
  CARD_RESULT_FIELDS,
  TOOL_CATALOG,
  getToolCatalogEntry,
  withheldInputKeys
} from '../../../src/mcp/toolCatalog.js';
import { partitionToolResult } from '../../../src/mcp/registerTools.js';

/**
 * The tool catalogue (#687): one entry for each tool the server defines and none for a tool it does not, and every
 * field a card reads from a result's _meta declared as the card's.
 */

const DEFINED = (Object.values(toolDefinitions) as unknown[])
  .filter((value): value is { name: string; handler: unknown } => typeof value === 'object' && value !== null && 'handler' in value)
  .map(tool => tool.name)
  .sort();

describe('the tool catalogue', () => {
  it('has an entry for each tool the server defines, and none for a tool it does not', () => {
    expect(DEFINED.length).toBeGreaterThan(40);
    expect(Object.keys(TOOL_CATALOG).sort()).toEqual(DEFINED);
  });

  it('refuses a tool it was not told of, rather than serving it by default', () => {
    expect(() => getToolCatalogEntry('no_such_tool')).toThrow(/no entry in src\/mcp\/toolCatalog\.ts/);
  });

  it('stops registration at a tool without Zod shapes, where it was quietly left out', async () => {
    const { registerLetterTools } = await import('../../../src/mcp/registerTools.js');
    const mcpServer = { registerResource: () => {}, registerTool: () => {} };
    const appServer = { listTools: () => [{ name: 'no_shapes_tool', description: 'x', readOnly: true, meta: {} }], execute: async () => ({}) };
    await expect(
      registerLetterTools(mcpServer as never, appServer as never, {
        userId: 'auth0|catalog',
        claims: {},
        token: 't',
        authType: 'jwt',
        scopes: ['mail:read']
      })
    ).rejects.toThrow(/no_shapes_tool has no input schema/);
  });

  it('makes the sends card-only, and keeps two tools for a card alone', () => {
    expect([...CARD_ONLY_SEND_TOOLS].sort()).toEqual(['create_mail_checkout', 'send_letter', 'send_postcard']);
    expect([...APP_ONLY_TOOLS].sort()).toEqual(['get_draft_status', 'upload_photo_chunk']);
  });

  it("declares every field a card reads from a result's _meta", () => {
    const widgets = join(__dirname, '../../../widgets');
    const files = [
      ...readdirSync(widgets).filter(name => name.endsWith('.html')).map(name => join(widgets, name)),
      ...readdirSync(join(widgets, 'shared')).filter(name => name.endsWith('.js')).map(name => join(widgets, 'shared', name))
    ];
    const read = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:\bmeta|toolMeta\(\)|currentMeta\(\)|_meta|toolResponseMetadata)\??\.([A-Za-z_]+)/g)) {
        read.add(match[1]);
      }
    }
    // Besides the card's own fields: a generated image's URL, which is the model's too, and the server's own switch.
    const alsoInMeta = new Set(['generatedImageUrl', 'modelContextEnabled']);
    expect(read.size).toBeGreaterThan(5);
    const undeclared = [...read].filter(field => !Object.hasOwn(CARD_RESULT_FIELDS, field) && !alsoInMeta.has(field));
    expect(undeclared).toEqual([]);
  });

  it('keeps each card field where it went before the catalogue: moved, kept as the card copy, or dropped', () => {
    expect(CARD_RESULT_FIELDS).toEqual({
      previewHtml: 'meta',
      previewFrontHtml: 'meta',
      previewBackHtml: 'meta',
      title: 'copy',
      overview: 'copy',
      purchaseStep: 'copy',
      examplePrompts: 'copy',
      headerImagePreview: 'meta',
      inlineImagePreview: 'meta',
      generatedImagePreview: 'meta',
      pageFit: 'meta',
      signatureImage: 'meta',
      mailServices: 'meta',
      stationeryDesigns: 'meta',
      inlineImageData: 'drop',
      headerImageData: 'drop',
      frontImageData: 'drop'
    });
  });

  it("withholds set_postcard_style's size while the sizes are off and its front while the layouts are", () => {
    const env = { LETTER_IRL_PRINT_RENDERER: 'pdf', LETTER_IRL_POSTCARD_SIZES_ENABLED: '', LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true' };
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, env);
      expect(withheldInputKeys('set_postcard_style')).toEqual(['size']);
      process.env.LETTER_IRL_POSTCARD_LAYOUTS_ENABLED = '';
      expect(withheldInputKeys('set_postcard_style')).toEqual(expect.arrayContaining(['layout', 'caption', 'place']));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('moves, copies and drops each card field as declared, and leaves the rest to the model', () => {
    const result: Record<string, unknown> = { draftId: 'd1', generatedImageUrl: 'https://x/y.png' };
    for (const field of Object.keys(CARD_RESULT_FIELDS)) result[field] = `${field}-value`;
    const plain = partitionToolResult(result, { kept: true });
    const withCopy = partitionToolResult(result, {}, true);
    for (const [field, use] of Object.entries(CARD_RESULT_FIELDS)) {
      expect(field in plain.structuredContent, field).toBe(false);
      expect(field in withCopy.structuredContent, field).toBe(use === 'copy');
      expect(field in plain._meta, field).toBe(use !== 'drop');
    }
    expect(plain.structuredContent).toEqual({ draftId: 'd1', generatedImageUrl: 'https://x/y.png' });
    expect(plain._meta).toMatchObject({ kept: true, generatedImageUrl: 'https://x/y.png' });
  });
});

/**
 * Saved stationery designs as tools/list and /manifest.json serve them (#649):
 * a real client over an in-memory transport. The three tools are listed only
 * while designs are offered (LETTER_IRL_CUSTOM_STATIONERY_ENABLED with
 * stationery offered); the letter previews take stationeryDesignId only then,
 * and set_stationery is served exactly as before designs until then.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { partitionToolResult, summarizeToolResult } from '../../../src/mcp/registerTools.js';
import type { ClientProfile } from '../../../src/auth/clientProfiles.js';
import { getRequiredToolScopes } from '../../../src/auth/toolScopes.js';
import { LetterIrlServer } from '../../../src/server.js';
import { STEERING_COPY_REV } from '../../../src/mcp/steeringRev.js';

const TOOLS = ['save_stationery_design', 'list_stationery_designs', 'delete_stationery_design'];
const PREVIEWS = ['quote_and_preview_letter', 'quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image'];

type Schema = {
  properties: Record<string, { type?: string; enum?: unknown[]; properties?: Record<string, unknown>; required?: string[]; items?: Schema }>;
  required?: string[];
  additionalProperties?: unknown;
};

const received: Array<Record<string, unknown>> = [];

async function connected() {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
  const real = new LetterIrlServer();
  const appServer = {
    listTools: (client: ClientProfile) => real.listTools(client),
    execute: vi.fn(async (request: { input: Record<string, unknown> }) => {
      received.push(request.input);
      throw new Error('stopped after recording the input');
    })
  } as unknown as LetterIrlServer;
  const server = await createMcpServer(appServer, {
    userId: 'auth0|test',
    claims: { azp: 'https://chatgpt.com/oauth/abc/client.json' },
    token: 'token',
    authType: 'jwt',
    scopes: ['mail:read', 'mail:draft', 'mail:send']
  });
  const client = new Client({ name: 'designs-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function listed() {
  const { tools } = await (await connected()).listTools();
  return new Map(tools.map(tool => [tool.name, tool]));
}

const manifestTools = () => new Map((buildManifest().tools as Array<{ name: string; inputSchema?: unknown }>).map(tool => [tool.name, tool]));
const properties = (tool: { inputSchema?: unknown } | undefined) => Object.keys((tool?.inputSchema as Schema | undefined)?.properties ?? {});

function stationery(on: boolean) {
  vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.stubEnv('LETTER_IRL_CUSTOM_STATIONERY_ENABLED', on ? 'true' : '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
});

describe('the design tools in tools/list and /manifest.json (#649)', () => {
  it('are not listed while designs are not offered: the flag off, stationery off, or the legacy renderer', async () => {
    for (const env of [
      { LETTER_IRL_CUSTOM_STATIONERY_ENABLED: '', LETTER_IRL_STATIONERY_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf' },
      { LETTER_IRL_CUSTOM_STATIONERY_ENABLED: 'ture', LETTER_IRL_STATIONERY_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'pdf' },
      { LETTER_IRL_CUSTOM_STATIONERY_ENABLED: 'true', LETTER_IRL_STATIONERY_ENABLED: '', LETTER_IRL_PRINT_RENDERER: 'pdf' },
      { LETTER_IRL_CUSTOM_STATIONERY_ENABLED: 'true', LETTER_IRL_STATIONERY_ENABLED: 'true', LETTER_IRL_PRINT_RENDERER: 'html' }
    ]) {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const tools = await listed();
      const manifest = manifestTools();
      for (const name of TOOLS) {
        expect(tools.has(name), `${name} ${JSON.stringify(env)}`).toBe(false);
        expect(manifest.has(name), `${name} manifest`).toBe(false);
      }
    }
  });

  it('are listed while offered, with what each takes and how each is annotated', async () => {
    stationery(true);
    const tools = await listed();
    for (const name of TOOLS) expect(manifestTools().has(name), name).toBe(true);

    const save = tools.get('save_stationery_design')!;
    expect(properties(save)).toEqual(['name', 'face', 'ornament', 'ruled', 'tone']);
    expect((save.inputSchema as Schema).required).toEqual(['name', 'face', 'ornament', 'ruled', 'tone']);
    expect((save.inputSchema as Schema).properties.face.enum).toEqual(['serif', 'typewriter', 'handwritten']);
    expect((save.inputSchema as Schema).properties.ornament.enum).toEqual(['none', 'monogram', 'sprig', 'confetti']);
    expect((save.inputSchema as Schema).properties.tone.enum).toEqual(['black', 'dark', 'medium', 'light']);
    expect(Object.keys((save.outputSchema as Schema).properties).sort()).toEqual(
      ['designId', 'face', 'message', 'name', 'ornament', 'replaced', 'ruled', 'tone'].sort()
    );
    expect(save.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });

    const list = tools.get('list_stationery_designs')!;
    expect(properties(list)).toEqual([]);
    expect(Object.keys((list.outputSchema as Schema).properties).sort()).toEqual(['designs', 'limit', 'message', 'rememberedDesignId']);
    expect(list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const remove = tools.get('delete_stationery_design')!;
    expect((remove.inputSchema as Schema).required).toEqual(['designId', 'confirm']);
    expect(remove.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it('save and delete on mail:draft, and list on mail:read, as the signature tools do', () => {
    expect(getRequiredToolScopes('save_stationery_design')).toEqual(['mail:draft']);
    expect(getRequiredToolScopes('delete_stationery_design')).toEqual(['mail:draft']);
    expect(getRequiredToolScopes('list_stationery_designs')).toEqual(['mail:read']);
  });

  it("are narrated in each tool's own sentence, never the design as JSON", () => {
    for (const name of TOOLS) {
      expect(summarizeToolResult(name, { message: 'Saved the design.', designs: [{ name: 'Garden' }] }), name).toBe('Saved the design.');
    }
  });

  it("narrates a preview drawn in a design by the design's name, asked for or remembered", () => {
    const preview = (source: string) =>
      summarizeToolResult('quote_and_preview_letter', {
        draftId: 'draft_0001',
        stationery: { theme: 'custom', name: 'Garden', designId: '3f2b8c1e-9a4d-4c7e-8b1f-2d6a5e9c0b7a', source }
      });
    expect(preview('asked')).toContain(' Stationery: the saved design "Garden".');
    expect(preview('remembered')).toContain(
      ` Stationery: the saved design "Garden", the account's last choice; stationery in the call or set_stationery changes it.`
    );
    expect(preview('asked')).not.toContain('3f2b8c1e');
  });

  it("give a letter card the account's designs in _meta, never the model (#649 part 4)", () => {
    const designs = [{ designId: '3f2b8c1e-9a4d-4c7e-8b1f-2d6a5e9c0b7a', name: 'Garden', design: { face: 'serif', ornament: 'none', ruled: false, tone: 'black' } }];
    const { structuredContent, _meta } = partitionToolResult({ draftId: 'draft_0001', canSendNow: true, stationeryDesigns: designs });
    expect(structuredContent).toEqual({ draftId: 'draft_0001', canSendNow: true });
    expect(_meta).toMatchObject({ stationeryDesigns: designs });
  });

  it('bump the steering copy revision', () => {
    expect(STEERING_COPY_REV).toBeGreaterThanOrEqual(47);
  });
});

describe('stationeryDesignId on the letter previews (#649)', () => {
  it('is served only while designs are offered, in tools/list and /manifest.json, and never on a postcard', async () => {
    stationery(false);
    const off = await listed();
    const offManifest = manifestTools();
    stationery(true);
    const on = await listed();
    const onManifest = manifestTools();
    for (const name of PREVIEWS) {
      expect(properties(off.get(name)), name).not.toContain('stationeryDesignId');
      expect(properties(offManifest.get(name)), name).not.toContain('stationeryDesignId');
      expect(properties(on.get(name)), name).toContain('stationeryDesignId');
      expect(properties(onManifest.get(name)), name).toContain('stationeryDesignId');
    }
    expect(properties(on.get('quote_and_preview_postcard'))).not.toContain('stationeryDesignId');
  });

  it('reaches the preview from a client while offered', async () => {
    stationery(true);
    const client = await connected();
    await client
      .callTool({
        name: 'quote_and_preview_letter',
        arguments: {
          recipient: { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' },
          bodyText: 'Dear Sam,',
          signOff: 'Pat',
          stationeryDesignId: '3f2b8c1e-9a4d-4c7e-8b1f-2d6a5e9c0b7a'
        }
      })
      .catch(error => error);
    expect(received).toHaveLength(1);
    expect(received[0].stationeryDesignId).toBe('3f2b8c1e-9a4d-4c7e-8b1f-2d6a5e9c0b7a');
  });
});

describe('set_stationery as designs change it (#649)', () => {
  it('is served exactly as before designs while they are not offered: a theme required, no stationeryDesignId', async () => {
    stationery(false);
    const served = (await listed()).get('set_stationery')!;
    expect(properties(served)).toEqual(['draftId', 'stationery', 'monogram', 'headline']);
    expect((served.inputSchema as Schema).required).toEqual(['draftId', 'stationery']);
    const manifest = manifestTools().get('set_stationery') as { inputSchema: Schema };
    expect(Object.keys(manifest.inputSchema.properties)).toEqual(['draftId', 'stationery', 'monogram', 'headline']);
    expect(manifest.inputSchema.required).toEqual(['draftId', 'stationery']);
  });

  it('takes a theme or a design while designs are offered, neither required by the schema', async () => {
    stationery(true);
    const served = (await listed()).get('set_stationery')!;
    expect(properties(served)).toEqual(['draftId', 'stationery', 'stationeryDesignId', 'monogram', 'headline']);
    expect((served.inputSchema as Schema).required).toEqual(['draftId']);
    const manifest = manifestTools().get('set_stationery') as { inputSchema: Schema };
    expect(Object.keys(manifest.inputSchema.properties)).toEqual(['draftId', 'stationery', 'stationeryDesignId', 'monogram', 'headline']);
    expect(manifest.inputSchema.required).toEqual(['draftId']);

    const client = await connected();
    await client.callTool({ name: 'set_stationery', arguments: { draftId: 'draft_0001', stationeryDesignId: 'abc' } }).catch(error => error);
    expect(received).toEqual([{ draftId: 'draft_0001', stationeryDesignId: 'abc' }]);
  });

  it("names the stationery the previews and set_stationery answer with, a design included, in their output schemas", async () => {
    stationery(true);
    const tools = await listed();
    for (const name of [...PREVIEWS, 'set_stationery']) {
      const output = (tools.get(name)!.outputSchema as Schema).properties.stationery as unknown as Schema & { properties: Record<string, { enum?: unknown[] }> };
      expect(output.properties.theme.enum, name).toContain('custom');
      expect(Object.keys(output.properties), name).toEqual(expect.arrayContaining(['designId', 'name', 'design']));
    }
  });
});

/**
 * set_postcard_style as tools/list and /manifest.json serve it (#594): a
 * real client over an in-memory transport (the stationeryServed pattern).
 * Listed only while the postcard sizes or layouts are offered, with `size`
 * only while the sizes are and `layout`, `caption` and `place` only while
 * the layouts are. While either is withheld the tool is served open to
 * unknown keys, so an argument from a schema cached while it was offered
 * reaches the tool, which refuses it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { type ClientProfile } from '../../../src/auth/clientProfiles.js';
import { LetterIrlServer } from '../../../src/server.js';

const TOOL = 'set_postcard_style';
const FRONT = ['layout', 'caption', 'place'];

/** The input each call reaches the app server with, through the SDK's validation. */
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
  const client = new Client({ name: 'postcard-style-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type Schema = { properties: Record<string, { enum?: string[]; description?: string }>; required?: string[]; additionalProperties?: unknown };

async function served(): Promise<Schema | undefined> {
  const { tools } = await (await connected()).listTools();
  return tools.find(tool => tool.name === TOOL)?.inputSchema as Schema | undefined;
}

function offer(sizes: boolean, layouts: boolean, renderer = 'pdf') {
  vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', sizes ? 'true' : '');
  vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', layouts ? 'true' : '');
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
}

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
});

describe('set_postcard_style in tools/list', () => {
  it('is not listed while neither the sizes nor the layouts are offered', async () => {
    for (const [sizes, layouts, renderer] of [[false, false, 'pdf'], [true, true, 'html']] as const) {
      offer(sizes, layouts, renderer);
      await expect(served(), `${sizes} ${layouts} ${renderer}`).resolves.toBeUndefined();
    }
  });

  it('takes a size and a front while both are offered, strict, with only the draft required', async () => {
    offer(true, true);
    const schema = (await served())!;
    expect(Object.keys(schema.properties).sort()).toEqual(['caption', 'draftId', 'layout', 'place', 'size']);
    expect(schema.properties.size.enum).toEqual(['6x9', '6x4', '6x11']);
    expect(schema.properties.layout.enum).toEqual(['full_bleed', 'border', 'greetings']);
    expect(schema.properties.size.description).toContain('a gift postcard stays a 6x9');
    expect(schema.properties.layout.description).toContain('Left out, the front stays as it is.');
    expect(schema.required).toEqual(['draftId']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('takes a size alone while only the sizes are offered, and a front alone while only the layouts are, open to the rest', async () => {
    offer(true, false);
    const sizes = (await served())!;
    expect(Object.keys(sizes.properties).sort()).toEqual(['draftId', 'size']);
    expect(sizes.additionalProperties).toBe(true);

    offer(false, true);
    const layouts = (await served())!;
    expect(Object.keys(layouts.properties).sort()).toEqual(['caption', 'draftId', 'layout', 'place']);
    expect(layouts.additionalProperties).toBe(true);
  });

  it('passes an argument withheld to the tool, whose own refusal runs, not the SDK strip', async () => {
    offer(true, false);
    const client = await connected();
    await client.callTool({ name: TOOL, arguments: { draftId: DRAFT_ID, layout: 'border', caption: 'Cape Cod' } });
    expect(received).toEqual([expect.objectContaining({ draftId: DRAFT_ID, layout: 'border', caption: 'Cape Cod' })]);

    offer(false, true);
    await (await connected()).callTool({ name: TOOL, arguments: { draftId: DRAFT_ID, size: '6x4' } });
    expect(received[1]).toMatchObject({ draftId: DRAFT_ID, size: '6x4' });
  });

  it('refuses a size or a layout it does not know while it serves them', async () => {
    offer(true, true);
    const client = await connected();
    for (const argument of [{ size: 'A5' }, { layout: 'collage' }]) {
      const result = await client.callTool({ name: TOOL, arguments: { draftId: DRAFT_ID, ...argument } }).catch(error => error);
      expect(JSON.stringify(result), JSON.stringify(argument)).toContain(`received '${Object.values(argument)[0]}'`);
    }
    expect(received).toHaveLength(0);
  });
});

describe('set_postcard_style in /manifest.json', () => {
  const style = () =>
    (buildManifest().tools as Array<{ name: string; inputSchema: Schema }>).find(tool => tool.name === TOOL)?.inputSchema;

  it('is listed as tools/list lists it, with the arguments offered', () => {
    offer(false, false);
    expect(style()).toBeUndefined();
    offer(true, true);
    expect(Object.keys(style()!.properties).sort()).toEqual(['caption', 'draftId', 'layout', 'place', 'size']);
    offer(true, false);
    expect(Object.keys(style()!.properties).sort()).toEqual(['draftId', 'size']);
    offer(false, true);
    for (const key of FRONT) expect(Object.keys(style()!.properties), key).toContain(key);
    expect(Object.keys(style()!.properties)).not.toContain('size');
  });
});

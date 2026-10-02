/**
 * The postcard preview's front as tools/list and /manifest.json serve it
 * (#594): a real client over an in-memory transport (the stationeryServed
 * pattern). `layout`, `caption` and `place` are served only while the
 * layouts are offered (the flag and our renderer). While they are not, the
 * postcard is served without them, open to unknown keys, so a front from a
 * schema cached while they were reaches the preview, which refuses it.
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

const KEYS = ['layout', 'caption', 'place'];

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
  const client = new Client({ name: 'postcard-layouts-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type Property = { type?: string; enum?: string[]; description?: string; default?: string };
type Schema = { properties: Record<string, Property>; required?: string[]; additionalProperties?: unknown };

async function listedTools() {
  const { tools } = await (await connected()).listTools();
  return new Map(tools.map(tool => [tool.name, tool.inputSchema as Schema]));
}

function offer(enabled: string, renderer: string) {
  vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', enabled);
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
}

const POSTCARD = {
  recipient: { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' },
  message: 'Wish you were here.',
  imageUrl: 'https://files.example/beach.jpg'
};

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
});

describe('the postcard front in tools/list', () => {
  it('is served while offered: the three layouts, a caption and a place, none required', async () => {
    offer('true', 'pdf');
    const { properties, required } = (await listedTools()).get('quote_and_preview_postcard')!;
    expect(properties.layout.enum).toEqual(['full_bleed', 'border', 'greetings']);
    expect(properties.layout.description).toContain('"Greetings from" a place over the photo');
    expect(properties.caption.description).toContain('For the border layout only');
    expect(properties.place.description).toContain('For the greetings layout only, and needed there');
    for (const key of KEYS) expect(required ?? [], key).not.toContain(key);
  });

  it('is not served while off, or without our renderer, and nothing else changes', async () => {
    offer('true', 'pdf');
    const on = await listedTools();
    for (const [enabled, renderer] of [['', 'pdf'], ['true', 'html']]) {
      offer(enabled, renderer);
      const off = await listedTools();
      const keys = Object.keys(off.get('quote_and_preview_postcard')!.properties);
      for (const key of KEYS) expect(keys, `${enabled} ${renderer}`).not.toContain(key);
      expect(keys).toEqual(Object.keys(on.get('quote_and_preview_postcard')!.properties).filter(key => !KEYS.includes(key)));
      for (const [name, schema] of off) {
        if (name === 'quote_and_preview_postcard') continue;
        // The renderer changes other tools (stationery, sizes); the layouts do not.
        if (renderer === 'pdf') expect(on.get(name), name).toEqual(schema);
      }
    }
  });

  it('passes a stray front through to the preview while off, so its refusal runs, not the SDK\'s strip', async () => {
    offer('', 'pdf');
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    // Open to unknown keys while the front is withheld, arrival dates on or not.
    expect((await listedTools()).get('quote_and_preview_postcard')!.additionalProperties).toBe(true);
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, layout: 'border', caption: 'Cape Cod' } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ layout: 'border', caption: 'Cape Cod' });
  });

  it('hands the preview a front as declared while offered, and refuses a layout it does not know', async () => {
    offer('true', 'pdf');
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, layout: 'greetings', place: 'Asheville' } });
    expect(received).toEqual([expect.objectContaining({ layout: 'greetings', place: 'Asheville' })]);
    const result = await client
      .callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, layout: 'collage' } })
      .catch(error => error);
    expect(received).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("received 'collage'");
  });
});

describe('the postcard front in /manifest.json', () => {
  const postcard = () =>
    (buildManifest().tools as Array<{ name: string; inputSchema: Schema }>).find(tool => tool.name === 'quote_and_preview_postcard')!.inputSchema;

  it('is served while offered, and withheld otherwise', () => {
    offer('true', 'pdf');
    const on = postcard();
    expect(on.properties.layout).toMatchObject({ type: 'string', enum: ['full_bleed', 'border', 'greetings'], default: 'full_bleed' });
    expect(on.properties.caption.type).toBe('string');
    expect(on.properties.place.type).toBe('string');
    for (const [enabled, renderer] of [['', 'pdf'], ['true', 'html']]) {
      offer(enabled, renderer);
      const off = postcard();
      for (const key of KEYS) expect(Object.keys(off.properties), `${enabled} ${renderer}`).not.toContain(key);
    }
  });
});

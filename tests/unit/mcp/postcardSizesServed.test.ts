/**
 * The postcard preview's size as tools/list and /manifest.json serve it
 * (#594): a real client over an in-memory transport (the arriveByServed and
 * stationeryServed pattern). While the 4x6 and 11x6 are not offered, `size`
 * is served exactly as before them, the 6x9 alone, and a size from a schema
 * cached while they were is refused by validation, never printed as a 6x9.
 * While offered (the flag, our renderer and Pay & Send), all three sizes are
 * served, described.
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
  const client = new Client({ name: 'postcard-sizes-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type Property = { type?: string; enum?: string[]; description?: string; default?: string; maxLength?: number };
type Schema = { properties: Record<string, Property>; required?: string[]; additionalProperties?: unknown };

async function listedTools() {
  const { tools } = await (await connected()).listTools();
  return new Map(tools.map(tool => [tool.name, tool.inputSchema as Schema]));
}

function offer(flag: string, renderer: string, payAndSend: string) {
  vi.stubEnv('LETTER_IRL_POSTCARD_SIZES_ENABLED', flag);
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
  vi.stubEnv('JIT_PURCHASE_ENABLED', payAndSend);
}

const NOT_OFFERED = [['', 'pdf', 'true'], ['true', 'html', 'true'], ['true', 'pdf', '']] as const;

const POSTCARD = {
  recipient: { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' },
  message: 'Wish you were here.',
  imageUrl: 'https://files.example/beach.jpg'
};

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
});

describe('the postcard size in tools/list', () => {
  it('is the three sizes while offered, described, the 6x9 the default', async () => {
    offer('true', 'pdf', 'true');
    const { properties, required } = (await listedTools()).get('quote_and_preview_postcard')!;
    expect(properties.size.type).toBe('string');
    expect(properties.size.enum).toEqual(['6x9', '6x4', '6x11']);
    expect(properties.size.description).toContain('6x4 for a 4 x 6 in postcard, or 6x11 for an 11 x 6 in one');
    expect(properties.size.description).toContain('a 4x6 or 11x6 is paid with Pay & Send');
    expect(required ?? []).not.toContain('size');
  });

  it("describes the message by each size's room while offered", async () => {
    offer('true', 'pdf', 'true');
    const { properties } = (await listedTools()).get('quote_and_preview_postcard')!;
    expect(properties.message.description).toBe(
      "Must fit the back of the postcard, which is measured in lines: 16 on a 6x9, about 500 characters of prose. size gives the other sizes' room."
    );
  });

  // With arrival dates off the postcard is served as an object open to
  // unknown keys (arriveBy withheld); with them on, as its raw shape.
  it.each(['', 'true'])('is the 6x9 alone while not offered, exactly as before, and nothing else changes (arrival dates %s)', async arriveBy => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', arriveBy);
    offer('true', 'pdf', 'true');
    const on = await listedTools();
    for (const [flag, renderer, payAndSend] of NOT_OFFERED) {
      offer(flag, renderer, payAndSend);
      const off = await listedTools();
      const label = `${flag} ${renderer} ${payAndSend}`;
      const served = off.get('quote_and_preview_postcard')!;
      // As it was served before #594: an enum of one, undescribed, and the 6x9's room.
      expect(served.properties.size, label).toEqual({ type: 'string', enum: ['6x9'] });
      expect(served.properties.message, label).toEqual({ type: 'string', description: 'Must fit the back of the postcard: 16 lines, about 500 characters of prose' });
      expect(served.additionalProperties, label).toBe(arriveBy !== 'true');
      const { size: _offered, message: _room, ...onRest } = on.get('quote_and_preview_postcard')!.properties;
      const { size: _narrowed, message: _sixByNine, ...offRest } = served.properties;
      expect(offRest, label).toEqual(onRest);
      expect(Object.keys(served.properties), label).toEqual(Object.keys(on.get('quote_and_preview_postcard')!.properties));
      for (const [name, schema] of off) {
        if (name === 'quote_and_preview_postcard') continue;
        // The renderer and Pay & Send change other tools; the sizes do not.
        if (renderer === 'pdf' && payAndSend === 'true') expect(on.get(name), `${label} ${name}`).toEqual(schema);
      }
    }
  });

  it.each(['', 'true'])('refuses a 4x6 from a cached schema by validation while not offered, before the preview (arrival dates %s)', async arriveBy => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', arriveBy);
    offer('', 'pdf', 'true');
    const client = await connected();
    const result = await client
      .callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, size: '6x4' } })
      .catch(error => error);
    expect(received).toHaveLength(0);
    const said = JSON.stringify(result);
    expect(said).toContain('size');
    expect(said).toContain("received '6x4'");
    // A 6x9, named or not, reaches it.
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, size: '6x9' } });
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: POSTCARD });
    expect(received.map(input => input.size)).toEqual(['6x9', undefined]);
  });

  it('hands the preview a 4x6 or an 11x6 while offered, and refuses a size it does not know', async () => {
    offer('true', 'pdf', 'true');
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, size: '6x4' } });
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, size: '6x11' } });
    expect(received.map(input => input.size)).toEqual(['6x4', '6x11']);
    const result = await client
      .callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, size: '5x7' } })
      .catch(error => error);
    expect(received).toHaveLength(2);
    expect(JSON.stringify(result)).toContain("received '5x7'");
  });
});

describe('the postcard size in /manifest.json', () => {
  const postcard = () =>
    (buildManifest().tools as Array<{ name: string; inputSchema: Schema }>).find(tool => tool.name === 'quote_and_preview_postcard')!.inputSchema;

  it('is the three sizes while offered, and the message may run to 2,000 characters', () => {
    offer('true', 'pdf', 'true');
    const { properties } = postcard();
    expect(properties.size.enum).toEqual(['6x9', '6x4', '6x11']);
    expect(properties.size.default).toBe('6x9');
    expect(properties.size.description).toContain('a 4x6 or 11x6 is paid with Pay & Send');
    expect(properties.message.maxLength).toBe(2_000);
  });

  it('is the 6x9 alone while not offered, its message to 1,000 characters, as before, arrival dates on or off', () => {
    offer('true', 'pdf', 'true');
    const on = postcard();
    // With arrival dates on, nothing is withheld from the postcard: only narrowed.
    for (const [[flag, renderer, payAndSend], arriveBy] of NOT_OFFERED.flatMap(combo => [[combo, ''], [combo, 'true']] as const)) {
      offer(flag, renderer, payAndSend);
      vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', arriveBy);
      const off = postcard();
      expect(Object.hasOwn(off.properties, 'arriveBy'), arriveBy).toBe(arriveBy === 'true');
      expect(off.properties.size).toEqual({
        type: 'string',
        enum: ['6x9'],
        default: '6x9',
        description: 'Postcard size (currently only 6x9 is supported)'
      });
      expect(off.properties.message.maxLength).toBe(1_000);
      expect(off.properties.message.description).toBe(on.properties.message.description);
      // In the same place among the properties.
      expect(Object.keys(off.properties).filter(key => key !== 'arriveBy')).toEqual(Object.keys(on.properties));
    }
  });
});

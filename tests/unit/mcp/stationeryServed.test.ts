/**
 * Stationery as tools/list serves it (#563): a real client over an in-memory
 * transport (the arriveByServed.test.ts pattern) sees `stationery`,
 * `monogram` and `headline` on the three letter previews only while
 * stationery is offered: LETTER_IRL_STATIONERY_ENABLED on, and our renderer
 * drawing the previews. A postcard never takes them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { type ClientProfile } from '../../../src/auth/clientProfiles.js';
import { LetterIrlServer } from '../../../src/server.js';
import { STATIONERY_THEMES } from '../../../src/render/index.js';

const LETTERS = ['quote_and_preview_letter', 'quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image'];
const KEYS = ['stationery', 'monogram', 'headline'];

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
  const client = new Client({ name: 'stationery-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type Schema = { properties: Record<string, { type?: string; enum?: string[]; description?: string }>; required?: string[]; additionalProperties?: unknown };

async function listedTools() {
  const { tools } = await (await connected()).listTools();
  return new Map(tools.map(tool => [tool.name, tool.inputSchema as Schema]));
}

function offer(enabled: string, renderer: string) {
  vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', enabled);
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
}

const LETTER = {
  recipient: { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' },
  bodyText: 'Dear Sam,',
  signOff: 'Pat'
};

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
});

describe('stationery in tools/list', () => {
  it('is served on the three letter previews while offered: the themes, the initials, the headline', async () => {
    offer('true', 'pdf');
    const tools = await listedTools();
    for (const name of LETTERS) {
      const { properties, required } = tools.get(name)!;
      expect(properties.stationery.type, name).toBe('string');
      expect(properties.stationery.enum).toEqual([...STATIONERY_THEMES]);
      expect(properties.stationery.description).toContain('classic, a plain page (the default)');
      expect(properties.monogram.description).toContain('with stationery monogram only');
      expect(properties.headline.description).toContain('with stationery celebration only');
      for (const key of KEYS) expect(required ?? [], `${name} ${key}`).not.toContain(key);
    }
    for (const key of KEYS) expect(tools.get('quote_and_preview_postcard')!.properties).not.toHaveProperty(key);
  });

  it('is not served while off, or without our renderer, and nothing else changes', async () => {
    offer('true', 'pdf');
    const on = await listedTools();
    for (const [enabled, renderer] of [['', 'pdf'], ['true', 'html']]) {
      offer(enabled, renderer);
      const off = await listedTools();
      for (const name of LETTERS) {
        const offKeys = Object.keys(off.get(name)!.properties);
        for (const key of KEYS) expect(offKeys, `${enabled} ${renderer} ${name}`).not.toContain(key);
        expect(offKeys).toEqual(Object.keys(on.get(name)!.properties).filter(key => !KEYS.includes(key)));
      }
      for (const [name, schema] of off) {
        if (LETTERS.includes(name)) continue;
        expect(on.get(name), name).toEqual(schema);
      }
      // set_stationery is listed only while offered (PR 5).
      expect([...on.keys()].filter(name => !off.has(name))).toEqual(['set_stationery']);
      expect([...off.keys()].filter(name => !on.has(name))).toEqual([]);
    }
  });

  it('serves the letter previews open to unknown keys while not offered, so a stray theme reaches the preview', async () => {
    offer('', 'pdf');
    const tools = await listedTools();
    for (const name of LETTERS) expect(tools.get(name)!.additionalProperties, name).toBe(true);
    const client = await connected();
    // An app that cached the schema from while it was offered.
    await client.callTool({ name: 'quote_and_preview_letter', arguments: { ...LETTER, stationery: 'botanical', headline: 'Hi' } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ stationery: 'botanical', headline: 'Hi' });
  });

  it('hands the preview a theme as declared while offered: its name in lower case, and none for an empty one', async () => {
    offer('true', 'pdf');
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_letter', arguments: { ...LETTER, stationery: ' Celebration ', headline: 'Hi' } });
    await client.callTool({ name: 'quote_and_preview_letter_with_image', arguments: { ...LETTER, stationery: '' } });
    expect(received[0]).toMatchObject({ stationery: 'celebration', headline: 'Hi' });
    expect(received[1].stationery).toBeUndefined();
  });

  it('refuses a theme it does not know before the preview, naming the themes', async () => {
    offer('true', 'pdf');
    const client = await connected();
    const result = await client
      .callTool({ name: 'quote_and_preview_letter', arguments: { ...LETTER, stationery: 'floral' } })
      .catch(error => error);
    expect(received).toHaveLength(0);
    const said = JSON.stringify(result);
    expect(said).toContain('stationery');
    expect(said).toContain("received 'floral'");
    for (const theme of STATIONERY_THEMES) expect(said, theme).toContain(`'${theme}'`);
  });

  it('hands the preview no theme for a null one, as for an empty one (review round 1)', async () => {
    offer('true', 'pdf');
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_letter', arguments: { ...LETTER, stationery: null } });
    expect(received).toHaveLength(1);
    expect(received[0].stationery).toBeUndefined();
    // And null initials or headline (#570 review round 2).
    await client.callTool({ name: 'quote_and_preview_letter', arguments: { ...LETTER, stationery: 'celebration', monogram: null, headline: null } });
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ stationery: 'celebration' });
    expect(received[1].monogram).toBeUndefined();
    expect(received[1].headline).toBeUndefined();
  });

  it("leaves the postcard's schema as it was, closed while arrival dates are on, stationery offered or not", async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    for (const [enabled, renderer] of [['', 'pdf'], ['true', 'html'], ['true', 'pdf']]) {
      offer(enabled, renderer);
      const tools = await listedTools();
      expect(tools.get('quote_and_preview_postcard')!.additionalProperties, `${enabled} ${renderer}`).toBe(false);
    }
  });
});

describe('set_stationery in tools/list (#563 PR 5)', () => {
  const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';

  it('is listed while offered: a draftId and a theme required, initials and a headline as the previews take them', async () => {
    offer('true', 'pdf');
    const tools = await listedTools();
    const schema = tools.get('set_stationery')!;
    expect(Object.keys(schema.properties)).toEqual(['draftId', 'stationery', 'monogram', 'headline']);
    expect(schema.required).toEqual(['draftId', 'stationery']);
    expect(schema.properties.stationery.enum).toEqual([...STATIONERY_THEMES]);
    expect(schema.properties.monogram.description).toBe(tools.get('quote_and_preview_letter')!.properties.monogram.description);
    expect(schema.properties.headline.description).toBe(tools.get('quote_and_preview_letter')!.properties.headline.description);
  });

  it('is not listed while not offered', async () => {
    for (const [enabled, renderer] of [['', 'pdf'], ['true', 'html']]) {
      offer(enabled, renderer);
      expect((await listedTools()).has('set_stationery'), `${enabled} ${renderer}`).toBe(false);
    }
  });

  it('hands the tool its input as declared, and refuses a missing theme before it', async () => {
    offer('true', 'pdf');
    const client = await connected();
    await client.callTool({ name: 'set_stationery', arguments: { draftId: DRAFT_ID, stationery: 'Monogram', monogram: 'JMS' } });
    expect(received).toEqual([{ draftId: DRAFT_ID, stationery: 'monogram', monogram: 'JMS' }]);

    const result = await client.callTool({ name: 'set_stationery', arguments: { draftId: DRAFT_ID } }).catch(error => error);
    expect(received).toHaveLength(1);
    expect(JSON.stringify(result)).toContain('stationery');
  });
});

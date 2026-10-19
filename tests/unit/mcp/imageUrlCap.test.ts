/**
 * Image links are bounded (#730): every tool input that takes an image link
 * refuses one past IMAGE_URL_MAX_LENGTH characters, through the SDK's own
 * validation, before the app server sees the call, and says how to go on. A
 * real client over an in-memory transport (the arriveByServed.test.ts pattern).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { type ClientProfile } from '../../../src/auth/clientProfiles.js';
import { LetterIrlServer } from '../../../src/server.js';

/** The limits, written out: the constants moving would otherwise move the test with them. */
const LIMIT = 4096;
const FILE_LIMIT = 8192;

const received: Array<Record<string, unknown>> = [];

async function connected(flags: Record<string, string> = {}) {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
  // Every tool that takes an image link is listed: collages, and signatures with the renderer that draws them.
  vi.stubEnv('LETTER_IRL_POSTCARD_COLLAGES_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', 'true');
  for (const [name, value] of Object.entries(flags)) vi.stubEnv(name, value);
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
  const client = new Client({ name: 'image-url-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const RECIPIENT = { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' };
const LETTER = { recipient: RECIPIENT, bodyText: 'Dear Sam,', signOff: 'Pat' };
const POSTCARD = { recipient: RECIPIENT, message: 'Wish you were here.' };

/** A link exactly `length` characters long. */
function link(length: number): string {
  const start = 'https://images.example/';
  return start + 'a'.repeat(length - start.length);
}

/** Each input that takes an image link, as a call carrying the given link there. */
const CALLS: Array<[string, string, (url: string) => Record<string, unknown>]> = [
  ['quote_and_preview_letter_with_header_image', 'imageUrl', url => ({ ...LETTER, imageUrl: url })],
  ['quote_and_preview_letter_with_image', 'imageUrl', url => ({ ...LETTER, imageUrl: url })],
  ['quote_and_preview_postcard', 'imageUrl', url => ({ ...POSTCARD, imageUrl: url })],
  ['quote_and_preview_postcard', 'imageUrls', url => ({ ...POSTCARD, imageUrls: [link(40), url] })],
  ['set_signature', 'imageUrl', url => ({ imageUrl: url })],
  ['confirm_uploaded_image', 'imageUrl', url => ({ imageUrl: url, context: 'postcard' })]
];

/** A file object as a host hands it over, with the given link. */
const file = (url: string) => ({ download_url: url, file_id: 'file-1', mime_type: 'image/jpeg', file_name: 'photo.jpg' });

/** Each input that takes a file object, as a call carrying a file with the given link there. */
const FILE_CALLS: Array<[string, string, (url: string) => Record<string, unknown>]> = [
  ['quote_and_preview_letter_with_header_image', 'image', url => ({ ...LETTER, image: file(url) })],
  ['quote_and_preview_letter_with_image', 'image', url => ({ ...LETTER, image: file(url) })],
  ['quote_and_preview_postcard', 'image', url => ({ ...POSTCARD, image: file(url) })],
  ['quote_and_preview_postcard', 'images', url => ({ ...POSTCARD, images: [file(link(40)), file(url)] })],
  ['set_signature', 'image', url => ({ image: file(url) })]
];

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const outcome = await client.callTool({ name, arguments: args }).catch((error: unknown) => error);
  return outcome instanceof Error ? outcome.message : JSON.stringify(outcome);
}

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
});

describe('image links (#730)', () => {
  it('states the limit in tools/list on every input that takes one', async () => {
    const tools = new Map((await (await connected()).listTools()).tools.map(tool => [tool.name, tool]));
    for (const [name, key] of CALLS) {
      const property = tools.get(name)?.inputSchema.properties?.[key] as { maxLength?: number; items?: { maxLength?: number } } | undefined;
      expect(property, `${name}.${key}`).toBeDefined();
      expect(key === 'imageUrls' ? property?.items?.maxLength : property?.maxLength, `${name}.${key}`).toBe(LIMIT);
    }
  });

  it.each(CALLS)('%s refuses a %s past the limit before the app sees it, and says what to do', async (name, _key, args) => {
    const client = await connected();
    const said = await call(client, name, args(link(LIMIT + 1)));
    if (name === 'set_signature') {
      // upload_image takes no signature, so it is not offered.
      expect(said).toContain(`A signature photo's link can be at most ${LIMIT} characters`);
      expect(said).not.toContain('upload_image');
    } else {
      expect(said).toContain(`An image link can be at most ${LIMIT} characters`);
      expect(said).toContain('upload_image');
    }
    expect(received).toHaveLength(0);
  });

  it.each(CALLS)('%s takes a %s at the limit', async (name, _key, args) => {
    const client = await connected();
    const said = await call(client, name, args(link(LIMIT)));
    expect(said).not.toContain('An image link can be at most');
    expect(received).toHaveLength(1);
  });
});

describe("a file object's link (#730)", () => {
  it("keeps the Apps SDK's file contract in tools/list: a plain string, no limit stated", async () => {
    const tools = new Map((await (await connected()).listTools()).tools.map(tool => [tool.name, tool]));
    for (const [name, key] of FILE_CALLS) {
      const property = tools.get(name)?.inputSchema.properties?.[key] as
        | { properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown> } }
        | undefined;
      const object = key === 'images' ? property?.items : property;
      expect(object?.properties?.download_url, `${name}.${key}`).toEqual({ type: 'string' });
    }
  });

  it.each(FILE_CALLS)('%s refuses a file in %s whose link is past the limit, before the app sees it', async (name, _key, args) => {
    const client = await connected();
    const said = await call(client, name, args(link(FILE_LIMIT + 1)));
    expect(said).toContain(`A file's link can be at most ${FILE_LIMIT} characters`);
    expect(said).toContain('upload_image');
    expect(received).toHaveLength(0);
  });

  it('is checked on a preview served while a field is withheld, which passes unknown keys through', async () => {
    // Arrive-by off: the previews are served as passthrough objects (getServedInputSchema).
    const client = await connected({ LETTER_IRL_ARRIVE_BY_ENABLED: '' });
    const served = (await client.listTools()).tools.find(tool => tool.name === 'quote_and_preview_letter_with_image');
    // The shape a withheld field gives: unknown keys pass through (registerTools.ts).
    expect(served?.inputSchema.additionalProperties).toEqual({});
    const said = await call(client, 'quote_and_preview_letter_with_image', { ...LETTER, image: file(link(FILE_LIMIT + 1)) });
    expect(said).toContain(`A file's link can be at most ${FILE_LIMIT} characters`);
    const linkSaid = await call(client, 'quote_and_preview_postcard', { ...POSTCARD, imageUrl: link(LIMIT + 1) });
    expect(linkSaid).toContain(`An image link can be at most ${LIMIT} characters`);
    expect(received).toHaveLength(0);
  });

  it.each(FILE_CALLS)('%s takes a file in %s whose link is at the limit', async (name, _key, args) => {
    const client = await connected();
    const said = await call(client, name, args(link(FILE_LIMIT)));
    expect(said).not.toContain("A file's link can be at most");
    expect(received).toHaveLength(1);
  });
});

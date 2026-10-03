/**
 * The postcard preview's collage photos as tools/list and /manifest.json serve
 * them (#616): a real client over an in-memory transport (the
 * postcardLayoutsServed pattern). `images` and `imageUrls` are served only
 * while collages are offered. While they are not, the postcard is served as it
 * was, open to unknown keys, so a collage from a schema cached while they were
 * served reaches the preview, which refuses it; and `images` is a file
 * parameter only while it is served.
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

const KEYS = ['images', 'imageUrls'];

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
  const client = new Client({ name: 'postcard-collages-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type Property = {
  type?: string;
  description?: string;
  items?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
};
type Schema = { properties: Record<string, Property>; required?: string[]; additionalProperties?: unknown };
type Listed = { name: string; inputSchema: Schema; _meta?: Record<string, unknown> };

async function listed() {
  const { tools } = await (await connected()).listTools();
  return new Map((tools as unknown as Listed[]).map(tool => [tool.name, tool]));
}

/**
 * Every other field the postcard preview withholds, offered: with them on, only the collage photos
 * being withheld can open the schema to unknown keys (arrive-by alone does while it is off).
 */
function allOtherFieldsOffered() {
  vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
}

function offer(enabled: string) {
  vi.stubEnv('LETTER_IRL_POSTCARD_COLLAGES_ENABLED', enabled);
}

const POSTCARD = {
  recipient: { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118', country: 'US' },
  message: 'Wish you were here.'
};
const file = (n: number) => ({ download_url: `https://files.example/${n}.jpg`, file_id: `file-${n}` });

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
});

describe('the collage photos in tools/list', () => {
  it('are served while offered: a list of file objects and a list of links, neither required', async () => {
    offer('true');
    const postcard = (await listed()).get('quote_and_preview_postcard')!;
    const { images, imageUrls } = postcard.inputSchema.properties;
    expect(images.type).toBe('array');
    expect(images.items?.type).toBe('object');
    // The Apps SDK's file contract: all four properties declared, the first two required.
    expect(Object.keys(images.items?.properties ?? {}).sort()).toEqual(['download_url', 'file_id', 'file_name', 'mime_type']);
    expect(images.items?.required).toEqual(['download_url', 'file_id']);
    expect(images.description).toContain('two to four photos attached in the conversation');
    expect(imageUrls.type).toBe('array');
    expect(imageUrls.items?.type).toBe('string');
    expect(imageUrls.description).toContain('two to four links to photos');
    for (const key of KEYS) {
      expect(postcard.inputSchema.required ?? [], key).not.toContain(key);
      expect(postcard.inputSchema.properties[key].description, key).toContain('never together with image or imageUrl');
    }
  });

  it('make images a file parameter while offered, beside image, and only then', async () => {
    offer('true');
    expect((await listed()).get('quote_and_preview_postcard')!._meta?.['openai/fileParams']).toEqual(['image', 'images']);
    for (const enabled of ['', 'false']) {
      offer(enabled);
      expect((await listed()).get('quote_and_preview_postcard')!._meta?.['openai/fileParams'], enabled).toEqual(['image']);
    }
  });

  it('are not served while off, and nothing else changes', async () => {
    offer('true');
    const on = await listed();
    offer('');
    const off = await listed();
    const keys = Object.keys(off.get('quote_and_preview_postcard')!.inputSchema.properties);
    for (const key of KEYS) expect(keys).not.toContain(key);
    expect(keys).toEqual(Object.keys(on.get('quote_and_preview_postcard')!.inputSchema.properties).filter(key => !KEYS.includes(key)));
    for (const [name, tool] of off) {
      if (name === 'quote_and_preview_postcard') continue;
      expect(on.get(name)!.inputSchema, name).toEqual(tool.inputSchema);
      expect(on.get(name)!._meta, name).toEqual(tool._meta);
    }
  });

  it('passes a stray collage through to the preview while off, so its refusal runs, not the SDK\'s strip', async () => {
    allOtherFieldsOffered();
    offer('true');
    expect((await listed()).get('quote_and_preview_postcard')!.inputSchema.additionalProperties).toBe(false);
    offer('');
    expect((await listed()).get('quote_and_preview_postcard')!.inputSchema.additionalProperties).toBe(true);
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, imageUrls: ['https://photos.example/1.jpg', 'https://photos.example/2.jpg'] } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ imageUrls: ['https://photos.example/1.jpg', 'https://photos.example/2.jpg'] });
  });

  it('hands the preview the photos as declared while offered', async () => {
    offer('true');
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, images: [file(1), file(2), file(3)] } });
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, imageUrls: ['https://photos.example/1.jpg', 'https://photos.example/2.jpg'] } });
    expect(received).toEqual([
      expect.objectContaining({ images: [file(1), file(2), file(3)] }),
      expect.objectContaining({ imageUrls: ['https://photos.example/1.jpg', 'https://photos.example/2.jpg'] })
    ]);
  });

  it('turns a path the host did not swap for a file into an unreadable photo, not an error of the schema\'s', async () => {
    offer('true');
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, images: [file(1), '/mnt/data/second.png', ''] } });
    expect(received).toHaveLength(1);
    const images = received[0].images as Array<{ download_url: string; file_id: string }>;
    expect(images[0]).toEqual(file(1));
    // The marker the single image's preprocess makes: an object with no address to download.
    // A blank slot in a list is a photo too, unlike the blank string for the whole list.
    for (const photo of images.slice(1)) {
      expect(photo.download_url).toBe('');
      expect(photo.file_id).toBe('letter-irl:unresolved-image-reference');
    }
  });

  it('reads a blank list, which a host sends for one left unset, as none, so a single photo still previews', async () => {
    offer('true');
    const client = await connected();
    for (const blank of ['', '   ']) {
      await client.callTool({
        name: 'quote_and_preview_postcard',
        arguments: { ...POSTCARD, imageUrl: 'https://photos.example/1.jpg', images: blank, imageUrls: blank }
      });
    }
    expect(received).toHaveLength(2);
    for (const input of received) {
      expect(input.images).toBeUndefined();
      expect(input.imageUrls).toBeUndefined();
      expect(input.imageUrl).toBe('https://photos.example/1.jpg');
    }
  });

  it('does not take a list of photos that is not a list', async () => {
    offer('true');
    const client = await connected();
    const result = await client
      .callTool({ name: 'quote_and_preview_postcard', arguments: { ...POSTCARD, imageUrls: 'https://photos.example/1.jpg' } })
      .catch(error => error);
    expect(received).toHaveLength(0);
    expect(JSON.stringify(result)).toMatch(/array/i);
  });
});

describe('the collage photos in /manifest.json', () => {
  const postcard = () =>
    (buildManifest().tools as Array<{ name: string; inputSchema: Schema }>).find(tool => tool.name === 'quote_and_preview_postcard')!.inputSchema;

  it('are served while offered, and withheld otherwise', () => {
    offer('true');
    const on = postcard();
    expect(on.properties.images).toMatchObject({ type: 'array', items: { type: 'object', required: ['download_url', 'file_id'] } });
    expect(on.properties.imageUrls).toMatchObject({ type: 'array', items: { type: 'string' } });
    offer('');
    for (const key of KEYS) expect(Object.keys(postcard().properties), key).not.toContain(key);
  });

  it('names the photos a collage drew in the output, always', () => {
    for (const enabled of ['true', '']) {
      offer(enabled);
      const tool = (buildManifest().tools as Array<{ name: string; outputSchema?: { properties: Record<string, unknown> } }>).find(
        entry => entry.name === 'quote_and_preview_postcard'
      )!;
      expect(tool.outputSchema?.properties.collagePhotos, enabled).toMatchObject({ type: 'integer' });
    }
  });
});

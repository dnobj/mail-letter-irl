/**
 * Arrive-by's field as tools/list serves it (#535): a real client over an
 * in-memory transport (the cardsWire.test.ts pattern) sees `arriveBy` on the
 * four preview tools only while LETTER_IRL_ARRIVE_BY_ENABLED is on, read when
 * the connection registers its tools.
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

const PREVIEWS = [
  'quote_and_preview_letter',
  'quote_and_preview_letter_with_header_image',
  'quote_and_preview_letter_with_image',
  'quote_and_preview_postcard'
];

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
  const client = new Client({ name: 'arrive-by-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function listedTools() {
  const { tools } = await (await connected()).listTools();
  return new Map(tools.map(tool => [tool.name, tool]));
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

describe('arriveBy in tools/list', () => {
  it('is served on the four preview tools while the flag is on, with its description', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    const tools = await listedTools();
    for (const name of PREVIEWS) {
      const properties = (tools.get(name)?.inputSchema as { properties?: Record<string, { description?: string }> }).properties!;
      expect(properties, name).toHaveProperty('arriveBy');
      expect(properties.arriveBy.description).toContain('YYYY-MM-DD');
    }
  });

  it('is not served while the flag is off, and nothing else changes', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    const off = await listedTools();
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    const on = await listedTools();
    for (const name of PREVIEWS) {
      const offProperties = Object.keys((off.get(name)?.inputSchema as { properties: object }).properties);
      const onProperties = Object.keys((on.get(name)?.inputSchema as { properties: object }).properties);
      expect(offProperties, name).not.toContain('arriveBy');
      expect(offProperties).toEqual(onProperties.filter(key => key !== 'arriveBy'));
    }
    // Every other tool is served the same either way.
    for (const [name, tool] of on) {
      if (PREVIEWS.includes(name)) continue;
      expect(off.get(name)?.inputSchema, name).toEqual(tool.inputSchema);
    }
  });

  it('delivers a stray arriveBy to the preview while off, so the preview refuses it, not mails at once', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    const client = await connected();
    // An app that cached the schema from while the flag was on.
    await client.callTool({ name: 'quote_and_preview_letter', arguments: { ...LETTER, arriveBy: '2026-10-16' } });
    expect(received).toHaveLength(1);
    expect(received[0].arriveBy).toBe('2026-10-16');
  });

  it('delivers arriveBy while on, as declared', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    const client = await connected();
    await client.callTool({ name: 'quote_and_preview_letter', arguments: { ...LETTER, arriveBy: '2026-10-16' } });
    expect(received[0].arriveBy).toBe('2026-10-16');
  });
});

/**
 * set_letter_words as tools/list serves it (#586): a real client over an
 * in-memory transport (the stationeryServed.test.ts pattern) sees the tool
 * only while room to write is offered: LETTER_IRL_ROOM_TO_WRITE_ENABLED on,
 * our renderer drawing the previews, and Pay & Send.
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

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';

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
  const client = new Client({ name: 'letter-words-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type Schema = { properties: Record<string, { type?: string; description?: string }>; required?: string[] };

async function listedTools() {
  const { tools } = await (await connected()).listTools();
  return new Map(tools.map(tool => [tool.name, tool]));
}

function offer(enabled: string, renderer: string, payAndSend: string) {
  vi.stubEnv('LETTER_IRL_ROOM_TO_WRITE_ENABLED', enabled);
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
  vi.stubEnv('JIT_PURCHASE_ENABLED', payAndSend);
}

afterEach(() => {
  vi.unstubAllEnvs();
  received.length = 0;
});

describe('set_letter_words in tools/list (#586)', () => {
  it('is listed while room to write is offered: a draftId and the words in full required', async () => {
    offer('true', 'pdf', 'true');
    const tool = (await listedTools()).get('set_letter_words')!;
    const schema = tool.inputSchema as Schema;
    expect(Object.keys(schema.properties)).toEqual(['draftId', 'bodyText', 'signOff', 'wordsVersion']);
    expect(schema.required).toEqual(['draftId', 'bodyText', 'signOff']);
    expect(schema.properties.bodyText.description).toMatch(/in full/);
    // The version of the words it replaces: optional to the schema, refused without by the tool, which gives the words (#593 review round 1).
    expect(schema.properties.wordsVersion.description).toMatch(/the answer gives the words as they are now/);
    // Changes a draft only: not read-only, not destructive, idempotent.
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });

  it('is not listed while room to write is not offered', async () => {
    for (const [enabled, renderer, payAndSend] of [['', 'pdf', 'true'], ['true', 'html', 'true'], ['true', 'pdf', '']]) {
      offer(enabled, renderer, payAndSend);
      expect((await listedTools()).has('set_letter_words'), `${enabled} ${renderer} ${payAndSend}`).toBe(false);
    }
  });

  it('hands the tool its input as declared, and refuses missing words before it', async () => {
    offer('true', 'pdf', 'true');
    const client = await connected();
    await client.callTool({ name: 'set_letter_words', arguments: { draftId: DRAFT_ID, bodyText: 'Dear Sam,', signOff: 'Pat' } });
    expect(received).toEqual([{ draftId: DRAFT_ID, bodyText: 'Dear Sam,', signOff: 'Pat' }]);

    const result = await client.callTool({ name: 'set_letter_words', arguments: { draftId: DRAFT_ID } }).catch(error => error);
    expect(received).toHaveLength(1);
    expect(JSON.stringify(result)).toContain('bodyText');
  });
});

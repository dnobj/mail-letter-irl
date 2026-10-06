/**
 * set_mail_service as tools/list and /manifest.json serve it (#625): listed
 * only while certified mail is offered (the flag, with Pay & Send), asking for
 * a draft and one of three services, callable by the letter card, and marked
 * as changing only a draft and safe to repeat.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { summarizeToolResult } from '../../../src/mcp/registerTools.js';
import type { ClientProfile } from '../../../src/auth/clientProfiles.js';
import { LetterIrlServer } from '../../../src/server.js';
import { getRequiredToolScopes } from '../../../src/auth/toolScopes.js';

type Schema = { required?: string[]; properties: Record<string, { type?: string; enum?: string[]; description?: string }> };

async function listed() {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
  const real = new LetterIrlServer();
  const appServer = {
    listTools: (client: ClientProfile) => real.listTools(client),
    execute: vi.fn()
  } as unknown as LetterIrlServer;
  const server = await createMcpServer(appServer, {
    userId: 'auth0|test',
    claims: { azp: 'https://chatgpt.com/oauth/abc/client.json' },
    token: 'token',
    authType: 'jwt',
    scopes: ['mail:read', 'mail:draft', 'mail:send']
  });
  const client = new Client({ name: 'set-mail-service-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return (await client.listTools()).tools;
}

const offer = () => {
  vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
  vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('set_mail_service in tools/list and /manifest.json (#625)', () => {
  it.each([
    ['the flag is off', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: '', JIT_PURCHASE_ENABLED: 'true' }],
    ['the flag is false', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'false', JIT_PURCHASE_ENABLED: 'true' }],
    ['Pay & Send is off', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'true', JIT_PURCHASE_ENABLED: 'false' }],
    ['the flag is a typo', { LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'ture', JIT_PURCHASE_ENABLED: 'true' }]
  ])('is not listed when %s', async (_name, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect((await listed()).map(tool => tool.name)).not.toContain('set_mail_service');
    expect((buildManifest().tools as Array<{ name: string }>).map(tool => tool.name)).not.toContain('set_mail_service');
    expect(new LetterIrlServer().listTools().map(tool => tool.name)).not.toContain('set_mail_service');
  });

  it('is listed while certified mail is offered, asking for a draft and one of three services', async () => {
    offer();
    for (const tool of [
      (await listed()).find(found => found.name === 'set_mail_service'),
      (buildManifest().tools as unknown as Array<{ name: string; inputSchema: unknown }>).find(found => found.name === 'set_mail_service')
    ]) {
      expect(tool).toBeDefined();
      const input = tool!.inputSchema as Schema;
      expect(input.required?.slice().sort()).toEqual(['draftId', 'mailService']);
      expect(input.properties.mailService.enum).toEqual(['standard', 'certified', 'certified_return_receipt']);
      expect(input.properties.mailService.description).toContain('Pay & Send');
    }
  });

  it('is marked as changing only a draft, safe to repeat and not destructive', async () => {
    offer();
    const tool = (await listed()).find(found => found.name === 'set_mail_service')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, destructiveHint: false });
    expect(tool.description).toContain('Nothing is sent by this tool');
  });

  it('answers with the terms the card shows, declared on its output', async () => {
    offer();
    const tool = (await listed()).find(found => found.name === 'set_mail_service')!;
    const output = tool.outputSchema as Schema;
    expect(Object.keys(output.properties).sort()).toEqual(
      ['canSendNow', 'deliveryClass', 'deliveryDisclaimer', 'draftId', 'mailService', 'message', 'pages', 'reasonCannotSend', 'sendEligibility'].sort()
    );
    expect(output.properties.mailService.enum).toEqual(['certified', 'certified_return_receipt']);
    expect(output.required?.slice().sort()).toEqual(['canSendNow', 'draftId', 'message', 'sendEligibility']);
  });

  it('is drafting, not sending, to the token that calls it', () => {
    expect(getRequiredToolScopes('set_mail_service')).toEqual(['mail:draft']);
  });

  it("is narrated in the tool's own sentence", () => {
    expect(summarizeToolResult('set_mail_service', { message: 'This letter now goes by USPS Certified Mail once sent.' })).toBe(
      'This letter now goes by USPS Certified Mail once sent.'
    );
    expect(summarizeToolResult('set_mail_service', {})).toBe('How the letter travels was changed.');
  });
});

describe('the steering copy (#625)', () => {
  it('is revised for the new tool', async () => {
    const { STEERING_COPY_REV } = await import('../../../src/mcp/steeringRev.js');
    expect(STEERING_COPY_REV).toBeGreaterThanOrEqual(40);
  });
});

describe('set_mail_service called through a real MCP client (#625)', () => {
  const received: Array<Record<string, unknown>> = [];

  async function connectedRecording() {
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
    const client = new Client({ name: 'set-mail-service-recording', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  const DRAFT = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
  const call = async (arguments_: Record<string, unknown>) =>
    (await connectedRecording()).callTool({ name: 'set_mail_service', arguments: arguments_ }).catch(error => error);

  afterEach(() => {
    received.length = 0;
  });

  it.each(['standard', 'certified', 'certified_return_receipt'])('delivers %s to the tool as declared', async service => {
    offer();
    await call({ draftId: DRAFT, mailService: service });
    expect(received).toEqual([{ draftId: DRAFT, mailService: service }]);
  });

  it.each([[undefined], [null], [''], ['Certified'], [' certified'], ['express'], [0], [['certified']]])(
    'refuses %j before the tool, listing the valid services',
    async mailService => {
      offer();
      const outcome = await call({ draftId: DRAFT, ...(mailService === undefined ? {} : { mailService }) });
      expect(received).toHaveLength(0);
      expect(JSON.stringify(outcome)).toContain('certified_return_receipt');
    }
  );

  it('is not a tool of the connection while certified mail is not offered: the tool is not reached', async () => {
    const outcome = await call({ draftId: DRAFT, mailService: 'certified' });
    expect(received).toHaveLength(0);
    expect(outcome instanceof Error ? outcome.message : JSON.stringify(outcome)).toMatch(/not found|unknown tool/i);
  });

  it('declares the same output on the served and the manifest layers', async () => {
    offer();
    const served = (await listed()).find(tool => tool.name === 'set_mail_service')!.outputSchema as Schema;
    const manifest = (buildManifest().tools as unknown as Array<{ name: string; outputSchema: Schema }>).find(tool => tool.name === 'set_mail_service')!
      .outputSchema;
    expect(manifest.required?.slice().sort()).toEqual(served.required?.slice().sort());
    expect(Object.keys(manifest.properties).sort()).toEqual(Object.keys(served.properties).sort());
    expect(manifest.properties.mailService.enum).toEqual(served.properties.mailService.enum);
    expect(manifest.properties.mailService.description).toBe(served.properties.mailService.description);
    expect(manifest.properties.canSendNow.description).toBe(served.properties.canSendNow.description);
  });
});

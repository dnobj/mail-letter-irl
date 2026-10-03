/**
 * Certified mail as tools/list and /manifest.json serve it (#625): the three
 * letter previews take mailService only while certified mail is offered (the
 * flag, with Pay & Send), never the postcard preview; their output schema
 * declares the field whatever the flag says (the output schema is closed); and
 * the narration names the service.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { summarizeToolResult, withheldInputKeys } from '../../../src/mcp/registerTools.js';
import type { ClientProfile } from '../../../src/auth/clientProfiles.js';
import { LetterIrlServer } from '../../../src/server.js';
import { MAIL_SERVICES } from '../../../src/config/certifiedMail.js';
import { STEERING_COPY_REV } from '../../../src/mcp/steeringRev.js';
import { quoteAndPreviewLetterTextOnlyTool } from '../../../src/tools/quoteAndPreviewLetterTextOnly.js';
import { quoteAndPreviewLetterWithHeaderImageTool } from '../../../src/tools/quoteAndPreviewLetterWithHeaderImage.js';
import { quoteAndPreviewLetterWithImageTool } from '../../../src/tools/quoteAndPreviewLetterWithImage.js';

const PREVIEWS = ['quote_and_preview_letter', 'quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image'];

type Schema = { properties: Record<string, { type?: string; enum?: string[]; description?: string }> };

async function listed(names: readonly string[]) {
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
  const client = new Client({ name: 'certified-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return tools.filter(tool => names.includes(tool.name));
}

const properties = (tool: { inputSchema?: unknown } | undefined) => Object.keys((tool?.inputSchema as Schema | undefined)?.properties ?? {});

/** The input each call reaches the app server with, through the SDK's validation. */
const received: Array<Record<string, unknown>> = [];

/** A connection whose app server records each call's input, then stops. */
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
  const client = new Client({ name: 'certified-recording-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
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

describe("the letter previews' mailService (#625)", () => {
  it('is served only while certified mail is offered, in tools/list and /manifest.json, and never on a postcard', async () => {
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
    const names = [...PREVIEWS, 'quote_and_preview_postcard'];
    const manifest = () => (buildManifest().tools as Array<{ name: string; inputSchema?: unknown }>).filter(tool => names.includes(tool.name));

    const off: Array<{ name: string; inputSchema?: unknown }> = [];
    for (const [flag, payAndSend] of [['', 'true'], ['false', 'true'], ['true', 'false'], ['ture', 'true']]) {
      vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', flag);
      vi.stubEnv('JIT_PURCHASE_ENABLED', payAndSend);
      off.push(...(await listed(names)), ...manifest());
    }
    vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    const on = [...(await listed(names)), ...manifest()];

    for (const name of PREVIEWS) {
      for (const tool of off.filter(found => found.name === name)) expect(properties(tool), name).not.toContain('mailService');
      const offered = on.filter(found => found.name === name);
      expect(offered, name).toHaveLength(2);
      for (const tool of offered) {
        const field = (tool.inputSchema as Schema).properties.mailService;
        expect(field.type, name).toBe('string');
        // Every service, in the order they are offered; standard is the default.
        expect(field.enum, name).toEqual([...MAIL_SERVICES]);
        expect(field.description, name).toContain('certified_return_receipt');
        expect(field.description, name).toContain('Pay & Send');
      }
    }
    for (const tool of [...off, ...on].filter(found => found.name === 'quote_and_preview_postcard')) {
      expect(properties(tool)).not.toContain('mailService');
    }
  });

  it('is withheld from exactly the three letter previews while it is not offered', () => {
    expect(withheldInputKeys('quote_and_preview_postcard')).not.toContain('mailService');
    expect(withheldInputKeys('set_stationery')).not.toContain('mailService');
    for (const name of PREVIEWS) expect(withheldInputKeys(name), name).toContain('mailService');
    vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    for (const name of PREVIEWS) expect(withheldInputKeys(name), name).not.toContain('mailService');
  });

  it("is declared in the previews' output schema whatever the flag says, as the two certified services", async () => {
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
    for (const flag of ['', 'true']) {
      vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', flag);
      vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
      for (const tool of await listed(PREVIEWS)) {
        const field = (tool.outputSchema as Schema).properties.mailService;
        expect(field.enum, `${tool.name}/${flag}`).toEqual(['certified', 'certified_return_receipt']);
      }
    }
    for (const tool of (buildManifest().tools as Array<{ name: string; outputSchema?: Schema }>).filter(found => PREVIEWS.includes(found.name))) {
      expect(tool.outputSchema?.properties.mailService.enum, tool.name).toEqual(['certified', 'certified_return_receipt']);
    }
  });

  it('is said in the three previews descriptions while it is offered, and only then', () => {
    const descriptions = () =>
      [quoteAndPreviewLetterTextOnlyTool, quoteAndPreviewLetterWithHeaderImageTool, quoteAndPreviewLetterWithImageTool].map(tool =>
        (tool.description as (client: unknown) => string)({})
      );
    for (const description of descriptions()) expect(description).not.toContain('Certified');
    vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    for (const description of descriptions()) {
      expect(description).toContain('USPS Certified Mail');
      expect(description).toContain('mailService "certified"');
      expect(description).toContain('never a letter pack or a gift letter');
      // Only on request, said to cost more, and said to be asked for again by the next preview.
      expect(description).toContain('Only when the person asks for USPS Certified Mail (it costs more)');
      expect(description).toContain('a new preview starts as an ordinary letter, so pass mailService again');
    }
  });

  it('is named in the narration, once, and not for an ordinary letter', () => {
    const preview = { lettersRequired: 1, sendEligibility: { packPays: false }, canSendNow: false };
    const say = (extra: Record<string, unknown>) => summarizeToolResult('quote_and_preview_letter', { ...preview, ...extra });
    expect(say({ mailService: 'certified' })).toContain(' Once sent, it goes by USPS Certified Mail, which gives a tracking number.');
    expect(say({ mailService: 'certified_return_receipt' })).toContain(
      ' Once sent, it goes by USPS Certified Mail with an electronic return receipt, which gives a tracking number.'
    );
    expect(say({ mailService: 'certified' }).match(/Certified Mail/g)).toHaveLength(1);
    // A preview has sent nothing: no sentence of it begins as though it had.
    expect(say({ mailService: 'certified' })).not.toContain('Sent as');
    expect(say({})).not.toContain('Certified');
    expect(say({ mailService: 'standard' })).not.toContain('Certified');
    expect(say({ mailService: 'express' })).not.toContain('Certified');
  });

  it('bumps the steering copy revision', () => {
    expect(STEERING_COPY_REV).toBeGreaterThanOrEqual(38);
  });
});

describe("the letter previews' mailService as a client sends it (#625)", () => {
  const send = async (arguments_: Record<string, unknown>) => {
    const client = await connectedRecording();
    return client.callTool({ name: 'quote_and_preview_letter', arguments: { ...LETTER, ...arguments_ } }).catch(error => error);
  };

  it.each([['certified'], ['certified_return_receipt'], ['standard']])('delivers %s to the preview while certified mail is offered', async service => {
    vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    await send({ mailService: service });
    expect(received).toHaveLength(1);
    expect(received[0].mailService).toBe(service);
  });

  it('takes null as no service, as a client that fills every field says it', async () => {
    vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    const outcome = await send({ mailService: null });
    expect(String(outcome?.message ?? '')).not.toContain('Input validation error');
    expect(received).toHaveLength(1);
    expect(received[0].mailService).toBeUndefined();
  });

  it.each([['Certified'], ['registered'], ['']])('refuses %j at the schema while certified mail is offered, listing what is valid', async service => {
    vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    const outcome = await send({ mailService: service });
    expect(received).toHaveLength(0);
    expect(JSON.stringify(outcome)).toContain('certified_return_receipt');
  });

  it('delivers a stray certified request to the preview while it is not offered, which refuses it', async () => {
    // An app that cached the schema from while it was offered.
    await send({ mailService: 'certified' });
    expect(received).toHaveLength(1);
    expect(received[0].mailService).toBe('certified');
  });
});

/**
 * Arrive-by as tools/list serves it (#535): a real client over an in-memory
 * transport (the cardsWire.test.ts pattern) sees `arriveBy` on the four
 * preview tools, and the set_arrival_date and cancel_scheduled_mail tools, only
 * while LETTER_IRL_ARRIVE_BY_ENABLED is on, read when the connection registers
 * its tools.
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

/** The tools listed only while the flag is on. */
const GATED = ['set_arrival_date', 'cancel_scheduled_mail'];

/** The input each call reaches the app server with, through the SDK's validation. */
const received: Array<Record<string, unknown>> = [];

/** A connection whose app server records each call's input, then answers with `answer` or stops. */
async function connected(answer?: (input: Record<string, unknown>) => Record<string, unknown>) {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
  const real = new LetterIrlServer();
  const appServer = {
    listTools: (client: ClientProfile) => real.listTools(client),
    execute: vi.fn(async (request: { input: Record<string, unknown> }) => {
      received.push(request.input);
      if (answer) return { result: answer(request.input), meta: {} };
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
    // Every other tool is served the same either way, but the two listed only
    // while on.
    for (const [name, tool] of on) {
      if (PREVIEWS.includes(name) || GATED.includes(name)) continue;
      expect(off.get(name)?.inputSchema, name).toEqual(tool.inputSchema);
    }
    expect([...on.keys()].filter(name => !off.has(name)).sort()).toEqual([...GATED].sort());
    expect([...off.keys()].filter(name => !on.has(name))).toEqual([]);
  });

  it('serves the four previews open to unknown keys while off, and closed while on', async () => {
    // While off the previews are a passthrough object (getServedInputSchema),
    // so a stray date reaches the preview and is refused; their JSON Schema
    // says so. Every other tool keeps the closed form either way.
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    const off = await listedTools();
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    // Closed only while nothing is withheld: the letter previews' stationery
    // (#563) is withheld too while it is not offered, and the postcard's
    // front while its layouts are not (#594).
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_POSTCARD_LAYOUTS_ENABLED', 'true');
    // And its collage photos while collages are not (#616).
    vi.stubEnv('LETTER_IRL_POSTCARD_COLLAGES_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
    // And the letter previews' signature while signatures are not (#608).
    vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', 'true');
    // And certified mail (#625), so no mail service is withheld from a letter.
    vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', 'true');
    // And saved stationery designs (#649), so no stationeryDesignId is withheld from a letter.
    vi.stubEnv('LETTER_IRL_CUSTOM_STATIONERY_ENABLED', 'true');
    vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
    const on = await listedTools();
    for (const name of PREVIEWS) {
      expect((off.get(name)?.inputSchema as { additionalProperties?: unknown }).additionalProperties, name).toBe(true);
      expect((on.get(name)?.inputSchema as { additionalProperties?: unknown }).additionalProperties, name).toBe(false);
    }
    for (const [name, tool] of off) {
      if (PREVIEWS.includes(name)) continue;
      expect((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties, name).not.toBe(true);
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

describe('set_arrival_date in tools/list', () => {
  const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';

  it('is listed while the flag is on: a draftId, and an optional arriveBy that clears when left out', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    const tool = (await listedTools()).get('set_arrival_date');
    expect(tool?.title).toBe('Set the arrival date');
    expect(tool?.description).toContain('Nothing is sent by this tool.');
    const schema = tool?.inputSchema as { properties: Record<string, { type?: string; description?: string }>; required?: string[] };
    expect(Object.keys(schema.properties)).toEqual(['draftId', 'arriveBy']);
    expect(schema.required).toEqual(['draftId']);
    expect(schema.properties.arriveBy.type).toBe('string');
    expect(schema.properties.arriveBy.description).toContain('YYYY-MM-DD');
    expect(schema.properties.arriveBy.description).toContain('Leave it out to clear the date');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
  });

  it('is not listed while the flag is off', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    expect((await listedTools()).has('set_arrival_date')).toBe(false);
  });

  it('reaches the app server with its input while on', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    const client = await connected();
    await client.callTool({ name: 'set_arrival_date', arguments: { draftId: DRAFT_ID, arriveBy: '2026-10-16' } });
    expect(received).toEqual([{ draftId: DRAFT_ID, arriveBy: '2026-10-16' }]);
  });

  it("returns a cleared date's result, which has no schedule, as its output schema allows", async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    const cleared = {
      draftId: DRAFT_ID,
      deliveryEstimate: 'Mailed in 1-2 business days; usually arrives in 1-2 weeks',
      message: 'No arrival date: once this mail is sent, it goes to the printer as soon as it can. Nothing has been sent.'
    };
    const client = await connected(() => cleared);
    await client.listTools();

    const result = await client.callTool({ name: 'set_arrival_date', arguments: { draftId: DRAFT_ID } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(cleared);
    expect(result.content).toEqual([{ type: 'text', text: cleared.message }]);
  });

  it('is listed with cancel_scheduled_mail, which needs an orderId and confirm, and is marked destructive', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    const tool = (await listedTools()).get('cancel_scheduled_mail');
    expect(tool?.title).toBe('Cancel scheduled mail');
    const schema = tool?.inputSchema as { properties: Record<string, { type?: string }>; required?: string[] };
    expect(Object.keys(schema.properties)).toEqual(['orderId', 'confirm']);
    expect(schema.required).toEqual(['orderId', 'confirm']);
    expect(schema.properties.confirm.type).toBe('boolean');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    });
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    expect((await listedTools()).has('cancel_scheduled_mail')).toBe(false);
  });

  it("returns a cancel's result through the served output schema", async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', 'true');
    const answer = {
      orderId: 'ltr-1',
      status: 'cancelled',
      alreadyCancelled: false,
      returned: { kind: 'gift_letter', count: 1 },
      message: 'Cancelled. The gift letter is back in the account, to use again.'
    };
    const client = await connected(() => answer);
    await client.listTools();

    const result = await client.callTool({ name: 'cancel_scheduled_mail', arguments: { orderId: 'ltr-1', confirm: true } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(answer);
    expect(result.content).toEqual([{ type: 'text', text: answer.message }]);
    expect(received).toEqual([{ orderId: 'ltr-1', confirm: true }]);
  });

  it('is unknown to a connection made while off, so a cached call reaches nothing', async () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    const client = await connected();
    const result = await client.callTool({ name: 'set_arrival_date', arguments: { draftId: DRAFT_ID, arriveBy: '2026-10-16' } }).catch(error => error);
    expect(received).toHaveLength(0);
    expect(JSON.stringify(result)).toMatch(/set_arrival_date/);
  });
});

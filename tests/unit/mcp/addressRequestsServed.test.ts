/**
 * The address request tools as tools/list and /manifest.json serve them
 * (#604): a real client over an in-memory transport (the postcardStyleServed
 * pattern). Listed only while LETTER_IRL_ADDRESS_REQUESTS_ENABLED is on, each
 * on mail:draft, and the server instructions name request_address only then.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { buildServerInstructions } from '../../../src/mcp/serverInstructions.js';
import { summarizeToolResult } from '../../../src/mcp/registerTools.js';
import { clientProfileNamed, type ClientProfile } from '../../../src/auth/clientProfiles.js';
import { getRequiredToolScopes } from '../../../src/auth/toolScopes.js';
import { LetterIrlServer } from '../../../src/server.js';

const TOOLS = ['request_address', 'get_address_request', 'cancel_address_request'];

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
  const client = new Client({ name: 'address-requests-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return { tools: tools.filter(tool => TOOLS.includes(tool.name)), instructions: client.getInstructions() ?? '' };
}

type Schema = { properties: Record<string, { type?: string; enum?: string[] }>; required?: string[] };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the address request tools in tools/list (#604)', () => {
  it('are not listed while address requests are off, and the instructions do not name them', async () => {
    for (const value of ['', 'false', 'ture']) {
      vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', value);
      const { tools, instructions } = await listed();
      expect(tools, value).toEqual([]);
      expect(instructions, value).not.toContain('request_address');
    }
  });

  it('are listed while on, with what each takes and how each is annotated', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', 'true');
    const { tools } = await listed();
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual([...TOOLS].sort());

    const request = byName.request_address.inputSchema as Schema;
    expect(Object.keys(request.properties).sort()).toEqual(['recipientName', 'senderFirstName']);
    expect(request.required).toEqual(['recipientName']);
    for (const name of ['get_address_request', 'cancel_address_request']) {
      expect((byName[name].inputSchema as Schema).required, name).toEqual(['requestId']);
    }
    const status = (byName.get_address_request.outputSchema as Schema).properties.status;
    expect(status.enum).toEqual(['waiting', 'answered', 'declined', 'cancelled', 'expired']);

    expect(byName.request_address.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(byName.get_address_request.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.cancel_address_request.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it('add request_address to the instructions while on', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', 'true');
    const { instructions } = await listed();
    expect(instructions).toContain(
      "If the person doesn't know the recipient's address, request_address makes a private link they can share for the recipient to give it; never guess an address."
    );
    expect(instructions).toBe(buildServerInstructions(false, clientProfileNamed('chatgpt')));
  });

  it('each need mail:draft: an answer is a third party\'s address', () => {
    for (const name of TOOLS) expect(getRequiredToolScopes(name), name).toEqual(['mail:draft']);
  });
});

describe('the address request tools in /manifest.json (#604)', () => {
  const names = () => (buildManifest().tools as Array<{ name: string }>).map(tool => tool.name);

  it('are listed as tools/list lists them', () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', '');
    for (const name of TOOLS) expect(names(), name).not.toContain(name);
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', 'true');
    for (const name of TOOLS) expect(names(), name).toContain(name);
  });
});

describe("the address request tools' text (#604)", () => {
  it('gives an answered address on one line, for an app whose model reads only the text', () => {
    const message = 'Ruth gave their address, so the mail can be previewed with it now.';
    expect(
      summarizeToolResult('get_address_request', {
        status: 'answered',
        message,
        recipient: { name: 'Ruth Example', addressLine1: '1 Main St', addressLine2: 'Apt 2', city: 'Tucson', state: 'AZ', postalCode: '85701', country: 'US' }
      })
    ).toBe(`${message} Address: Ruth Example, 1 Main St, Apt 2, Tucson, AZ 85701.`);
    expect(summarizeToolResult('get_address_request', { status: 'waiting', message: 'Ruth has not answered yet.' })).toBe(
      'Ruth has not answered yet.'
    );
  });

  it("says request_address's sentence, which carries the link", () => {
    expect(summarizeToolResult('request_address', { message: 'Here is the link to send Ruth: https://x.example/address/t' })).toBe(
      'Here is the link to send Ruth: https://x.example/address/t'
    );
  });
});

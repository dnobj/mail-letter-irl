import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * One tool contract (#688). src/zodSchemas.ts is the only definition of a tool's schemas: tools/list serves it, and
 * /manifest.json is generated from the same served shapes with the SDK's own converter. These used to compare a
 * hand-written JSON copy with the Zod one, field by field; now the manifest is shown equal to tools/list for every
 * tool, and the few facts worth pinning are read from what is served.
 */

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest, servedToolJsonSchemas } from '../../../src/mcp/manifest.js';
import { LetterIrlServer } from '../../../src/server.js';

const ALL_ON: Record<string, string> = {
  LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true',
  LETTER_IRL_ARRIVE_BY_ENABLED: 'true',
  LETTER_IRL_STATIONERY_ENABLED: 'true',
  LETTER_IRL_PRINT_RENDERER: 'pdf',
  LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'true',
  JIT_PURCHASE_ENABLED: 'true',
  LETTER_IRL_WORDS_EDITOR_ENABLED: 'true',
  LETTER_IRL_POSTCARD_SIZES_ENABLED: 'true',
  LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true',
  LETTER_IRL_POSTCARD_COLLAGES_ENABLED: 'true',
  LETTER_IRL_ADDRESS_REQUESTS_ENABLED: 'true',
  LETTER_IRL_SIGNATURES_ENABLED: 'true',
  LETTER_IRL_CUSTOM_STATIONERY_ENABLED: 'true',
  LETTER_IRL_HOME_ENABLED: 'true'
};
const ALL_OFF = Object.fromEntries(Object.keys(ALL_ON).map(key => [key, '']));

async function servedTools() {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
  const server = await createMcpServer(new LetterIrlServer(), {
    userId: 'auth0|contract',
    claims: { azp: 'https://chatgpt.com/oauth/abc/client.json' },
    token: 'token',
    authType: 'jwt',
    scopes: ['mail:read', 'mail:draft', 'mail:send']
  });
  const client = new Client({ name: 'contract', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map(tool => [tool.name, tool]));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('one tool contract (#688)', () => {
  it.each([['all off', ALL_OFF], ['all on', ALL_ON]])(
    'serves each tool in /manifest.json exactly as tools/list does: %s',
    async (_label, env) => {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const served = await servedTools();
      const manifest = buildManifest().tools as Array<{ name: string; inputSchema: unknown; outputSchema: unknown }>;
      expect(manifest.map(tool => tool.name)).toEqual([...served.keys()]);
      for (const tool of manifest) {
        expect(tool.inputSchema, `${tool.name} input`).toEqual(served.get(tool.name)!.inputSchema);
        expect(tool.outputSchema, `${tool.name} output`).toEqual(served.get(tool.name)!.outputSchema);
      }
    },
    60_000
  );

  it('asks send_letter for the draft and a confirmation, and the checkout for a draft alone, never a price', () => {
    const send = servedToolJsonSchemas('send_letter').inputSchema;
    expect(send.required).toEqual(expect.arrayContaining(['draftId', 'confirm']));
    const checkout = servedToolJsonSchemas('create_mail_checkout').inputSchema;
    expect(Object.keys(checkout.properties)).toEqual(['draftId', 'contentVersion', 'sendAnotherCopy']);
    expect(checkout.required).toEqual(['draftId']);
    // The version the person was shown (#695): asked for, never required, for one release.
    for (const schema of [send, checkout, servedToolJsonSchemas('send_postcard').inputSchema]) {
      expect(schema.properties.contentVersion).toMatchObject({ type: 'string' });
      expect(schema.required).not.toContain('contentVersion');
    }
    expect(Object.keys(servedToolJsonSchemas('get_purchase_status').inputSchema.properties)).toEqual(['orderId']);
  });

  it("requires set_arrival_date's draft alone and both of cancel_scheduled_mail's inputs", () => {
    expect(servedToolJsonSchemas('set_arrival_date').inputSchema.required).toEqual(['draftId']);
    expect([...servedToolJsonSchemas('cancel_scheduled_mail').inputSchema.required].sort()).toEqual(['confirm', 'orderId']);
  });

  it('leaves the arrival-date tools out of the manifest while arrival dates are off', () => {
    vi.stubEnv('LETTER_IRL_ARRIVE_BY_ENABLED', '');
    const names = (buildManifest().tools as Array<{ name: string }>).map(tool => tool.name);
    expect(names).not.toContain('set_arrival_date');
    expect(names).not.toContain('cancel_scheduled_mail');
  });
});

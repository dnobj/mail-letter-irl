import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every served tool's annotations.title is its title (#861). The Claude directory portal flags a tool without
 * annotations.title; registerTools copies the title into the annotations in one place, so the two cannot drift.
 * Checked through a real MCP client's tools/list, for every kind of app, with every flag off and on.
 */

const profileOverride = vi.hoisted(() => ({ name: 'generic' as string }));
vi.mock('../../../src/auth/clientProfiles.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/auth/clientProfiles.js')>();
  return {
    ...actual,
    resolveClientProfile: () => actual.clientProfileNamed(profileOverride.name as never)
  };
});

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { CLIENT_PROFILE_NAMES } from '../../../src/auth/clientProfiles.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';

const ON: Record<string, string> = {
  LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true',
  LETTER_IRL_CARD_UPLOAD_ENABLED: 'true',
  LETTER_IRL_ARRIVE_BY_ENABLED: 'true',
  LETTER_IRL_STATIONERY_ENABLED: 'true',
  LETTER_IRL_PRINT_RENDERER: 'pdf',
  LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'true',
  JIT_PURCHASE_ENABLED: 'true',
  LETTER_IRL_WORDS_EDITOR_ENABLED: 'true',
  LETTER_IRL_ROOM_TO_WRITE_ENABLED: 'true',
  LETTER_IRL_POSTCARD_SIZES_ENABLED: 'true',
  LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true',
  LETTER_IRL_POSTCARD_COLLAGES_ENABLED: 'true',
  LETTER_IRL_ADDRESS_REQUESTS_ENABLED: 'true',
  LETTER_IRL_SIGNATURES_ENABLED: 'true',
  LETTER_IRL_CUSTOM_STATIONERY_ENABLED: 'true',
  LETTER_IRL_HOME_ENABLED: 'true',
  LETTER_IRL_GIFT_LETTERS_ENABLED: 'true',
  LETTER_IRL_STUDIO_CARD_ENABLED: 'true',
  LETTER_IRL_ENVELOPE_REVEAL_ENABLED: 'true'
};
const OFF = Object.fromEntries(Object.keys(ON).map(key => [key, key === 'JIT_PURCHASE_ENABLED' ? 'false' : '']));

async function listTools(app: string, env: Record<string, string>) {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  profileOverride.name = app;
  const { LetterIrlServer } = await import('../../../src/server.js');
  const server = await createMcpServer(new LetterIrlServer(), {
    userId: 'auth0|annotations-title',
    claims: {},
    token: 'token',
    authType: 'jwt',
    scopes: ['mail:read', 'mail:draft', 'mail:send']
  });
  const client = new Client({ name: 'annotations-title', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('annotations.title (#861)', () => {
  const cases = CLIENT_PROFILE_NAMES.flatMap(app => [
    [app, 'all off', OFF],
    [app, 'all on', ON]
  ] as Array<[string, string, Record<string, string>]>);

  it.each(cases)('equals the title on every tool served to %s, flags %s', async (_app, _label, env) => {
    const tools = await listTools(_app, env);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title, tool.name).toEqual(expect.any(String));
      expect(tool.title!.length, tool.name).toBeGreaterThan(0);
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
    }
  }, 60_000);
});

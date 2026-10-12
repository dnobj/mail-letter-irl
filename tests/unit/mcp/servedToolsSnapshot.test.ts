import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What tools/list serves and what the manifest says, for every flag alone, all off and all on, for each kind of app
 * (#687). Taken before the tool catalogue moved the listing, registration and result rules into one place, so that
 * move is shown to change nothing: a digest of each full answer is kept, and any byte that changes shows here.
 * A change that means to change what is served updates this file on purpose (vitest -u), and says why.
 */

const profileOverride = vi.hoisted(() => ({ name: 'generic' as string }));
vi.mock('../../../src/auth/clientProfiles.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/auth/clientProfiles.js')>();
  return {
    ...actual,
    resolveClientProfile: () => actual.clientProfileNamed(profileOverride.name as never)
  };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';

/** Every flag that changes what is listed or how. */
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
const CONFIGS: Array<[string, Record<string, string>]> = [
  ['all off', OFF],
  ['all on', ON],
  ...Object.keys(ON).map(key => [`only ${key}`, { ...OFF, [key]: ON[key] }] as [string, Record<string, string>])
];
// One app of each kind: cards and purchases, cards without, a model that reads structuredContent, one that trusts
// nothing, and a personal access token.
const APPS = ['chatgpt', 'claude', 'claude_code', 'vscode', 'token'];

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

async function served(app: string) {
  profileOverride.name = app;
  const { LetterIrlServer } = await import('../../../src/server.js');
  const server = await createMcpServer(new LetterIrlServer(), {
    userId: 'auth0|snapshot',
    claims: {},
    token: 'token',
    authType: app === 'token' ? 'pat' : 'jwt',
    scopes: app === 'token' ? ['mail:read', 'mail:draft'] : ['mail:read', 'mail:draft', 'mail:send']
  });
  const client = new Client({ name: 'snapshot', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('what is served, before and after the tool catalogue (#687)', () => {
  it('is unchanged for every flag and every kind of app', async () => {
    const snapshot: Record<string, unknown> = {};
    for (const [label, env] of CONFIGS) {
      vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
      vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const config: Record<string, unknown> = { manifest: digest(buildManifest()) };
      for (const app of APPS) {
        const tools = await served(app);
        config[app] = { names: tools.map(tool => tool.name).join(' '), digest: digest(tools) };
      }
      snapshot[label] = config;
      vi.unstubAllEnvs();
    }
    await expect(JSON.stringify(snapshot, null, 2)).toMatchFileSnapshot('./__snapshots__/servedTools.json');
  }, 120_000);
});

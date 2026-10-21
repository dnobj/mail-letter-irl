import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The full tools/list ChatGPT is served, readable, for the launch cut and for every flag on (#816). The digests in
 * servedToolsSnapshot.test.ts say that something changed; this file says what, so a change to what the submission
 * scan reads can be reviewed line by line. A change that means to change it updates the file on purpose (vitest -u).
 */

const profileOverride = vi.hoisted(() => ({ name: 'chatgpt' as string }));
vi.mock('../../../src/auth/clientProfiles.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/auth/clientProfiles.js')>();
  return {
    ...actual,
    resolveClientProfile: () => actual.clientProfileNamed(profileOverride.name as never)
  };
});

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';

/**
 * The launch cut, approved by the owner on 2026-10-20 (#816): group 1 on; group 2 (certified mail, signatures, card
 * upload) on, as each is once its step is done; group 3 off. This file is the list the submission scan reads: when a
 * group 2 feature stays off, or a live check turns one off, set it here and re-record (vitest -u).
 */
const LAUNCH: Record<string, string> = {
  LETTER_IRL_PRINT_RENDERER: 'pdf',
  JIT_PURCHASE_ENABLED: 'true',
  LETTER_IRL_SEND_CONFIRMATION_ENABLED: 'true',
  LETTER_IRL_STUDIO_CARD_ENABLED: 'true',
  LETTER_IRL_STATIONERY_ENABLED: 'true',
  LETTER_IRL_ROOM_TO_WRITE_ENABLED: 'true',
  LETTER_IRL_POSTCARD_SIZES_ENABLED: 'true',
  LETTER_IRL_POSTCARD_LAYOUTS_ENABLED: 'true',
  LETTER_IRL_POSTCARD_COLLAGES_ENABLED: 'true',
  LETTER_IRL_ARRIVE_BY_ENABLED: 'true',
  LETTER_IRL_ENVELOPE_REVEAL_ENABLED: 'true',
  LETTER_IRL_GIFT_LETTERS_ENABLED: 'true',
  LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'true',
  LETTER_IRL_SIGNATURES_ENABLED: 'true',
  LETTER_IRL_CARD_UPLOAD_ENABLED: 'true',
  LETTER_IRL_HOME_ENABLED: '',
  LETTER_IRL_ADDRESS_REQUESTS_ENABLED: '',
  LETTER_IRL_CUSTOM_STATIONERY_ENABLED: '',
  LETTER_IRL_WORDS_EDITOR_ENABLED: '',
  LETTER_IRL_IMAGE_GEN_MODE: 'off'
};
const ALL_ON: Record<string, string> = {
  ...LAUNCH,
  LETTER_IRL_HOME_ENABLED: 'true',
  LETTER_IRL_ADDRESS_REQUESTS_ENABLED: 'true',
  LETTER_IRL_CUSTOM_STATIONERY_ENABLED: 'true',
  LETTER_IRL_WORDS_EDITOR_ENABLED: 'true',
  LETTER_IRL_IMAGE_GEN_MODE: 'on'
};

async function listed() {
  const { LetterIrlServer } = await import('../../../src/server.js');
  const server = await createMcpServer(new LetterIrlServer(), {
    userId: 'auth0|golden',
    claims: {},
    token: 'token',
    authType: 'jwt',
    scopes: ['mail:read', 'mail:draft', 'mail:send']
  });
  const client = new Client({ name: 'golden', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the tools/list ChatGPT is served (#816)', () => {
  for (const [label, file, env] of [
    ['the launch cut', 'chatgpt-launch', LAUNCH],
    ['every flag on', 'chatgpt-all-on', ALL_ON]
  ] as const) {
    it(`reads as recorded for ${label}`, async () => {
      vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
      vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const tools = await listed();
      await expect(JSON.stringify(tools, null, 2) + '\n').toMatchFileSnapshot(`./__snapshots__/tools-list.${file}.json`);
    }, 120_000);

    // SDK v2 does not export its converter, so /manifest.json makes the same call itself (#477): held equal here.
    it(`gives /manifest.json the schemas tools/list serves, tool by tool, for ${label}`, async () => {
      vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
      vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      const listedByName = new Map((await listed()).map(tool => [tool.name, tool]));
      const manifest = buildManifest().tools as Array<{ name: string; inputSchema: unknown; outputSchema: unknown }>;
      const compared = manifest.filter(tool => listedByName.has(tool.name));
      expect(compared.length).toBeGreaterThan(20);
      for (const tool of compared) {
        expect(tool.inputSchema, `${tool.name} input`).toEqual(listedByName.get(tool.name)!.inputSchema);
        expect(tool.outputSchema, `${tool.name} output`).toEqual(listedByName.get(tool.name)!.outputSchema);
      }
    }, 120_000);
  }
});

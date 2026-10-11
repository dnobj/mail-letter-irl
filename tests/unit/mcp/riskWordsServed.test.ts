/**
 * No tool rates its own risk in what ChatGPT is served (#543, #670): a real client over an in-memory transport (the
 * arriveByServed.test.ts pattern) reads tools/list and the server instructions as ChatGPT does, the input and output
 * schemas as served from zodSchemas.ts, every switch on and off and the send rule both ways. ChatGPT's approval dialog
 * flagged "This does not send mail" and "Nothing is sent by this tool" as a "Suspicious Instruction".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { LetterIrlServer } from '../../../src/server.js';
import { A_REMOVED_RISK_SENTENCE, SWITCH_STATES, everyFlag, modelFacingStrings } from '../../fixtures/riskWords.js';

async function chatgpt() {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
  const server = await createMcpServer(new LetterIrlServer(), {
    userId: 'auth0|test',
    claims: { azp: 'https://chatgpt.com/oauth/abc/client.json' },
    token: 'token',
    authType: 'jwt',
    scopes: ['mail:read', 'mail:draft', 'mail:send']
  });
  const client = new Client({ name: 'risk-words-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

afterEach(() => vi.unstubAllEnvs());

describe('what ChatGPT is served rates no tool by its risk (#543, #670)', () => {
  it.each(
    SWITCH_STATES.flatMap(([on, paidPerSend, imageGen]) =>
      ['true', 'false'].map(sendRule => [on, paidPerSend, imageGen, sendRule] as const)
    )
  )('switches on: %s, paid per send: %s, images: %s, send rule: %s', async (on, paidPerSend, imageGen, sendRule) => {
    everyFlag(on, paidPerSend, imageGen);
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', sendRule);
    const client = await chatgpt();
    const { tools } = await client.listTools();
    if (on)
      expect(tools.map(tool => tool.name)).toEqual(
        expect.arrayContaining(['save_stationery_design', 'set_postcard_style', 'open_letter_home'])
      );
    if (paidPerSend) expect(tools.map(tool => tool.name)).toContain('set_mail_service');
    for (const tool of tools) {
      // The whole tool as served: its title, description, annotations, and input and output schemas.
      const said = modelFacingStrings(tool);
      expect(said.length, tool.name).toBeGreaterThan(0);
      for (const text of said) expect(text, tool.name).not.toMatch(A_REMOVED_RISK_SENTENCE);
    }
    expect(client.getInstructions() ?? '').not.toMatch(A_REMOVED_RISK_SENTENCE);
    await client.close();
  });

  it('reads the served schemas, where a field described as sending nothing would be caught', async () => {
    everyFlag(true);
    vi.stubEnv('LETTER_IRL_SEND_CONFIRMATION_ENABLED', 'true');
    const client = await chatgpt();
    const { tools } = await client.listTools();
    const save = tools.find(tool => tool.name === 'save_stationery_design');
    expect(modelFacingStrings(save?.inputSchema)).toEqual(
      expect.arrayContaining([expect.stringContaining('ask the person before reusing one')])
    );
    await client.close();
  });
});

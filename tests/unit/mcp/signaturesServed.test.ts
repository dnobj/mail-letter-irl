/**
 * The signature tools as tools/list and /manifest.json serve them (#608): a
 * real client over an in-memory transport (the addressRequestsServed
 * pattern). Listed only while LETTER_IRL_SIGNATURES_ENABLED is on and our
 * renderer draws letters; the saved picture reaches a card in _meta, never
 * the model.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { partitionToolResult, summarizeToolResult } from '../../../src/mcp/registerTools.js';
import type { ClientProfile } from '../../../src/auth/clientProfiles.js';
import { getRequiredToolScopes } from '../../../src/auth/toolScopes.js';
import { LetterIrlServer } from '../../../src/server.js';

const TOOLS = ['set_signature', 'get_signature', 'clear_signature'];

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
  const client = new Client({ name: 'signatures-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return tools.filter(tool => TOOLS.includes(tool.name));
}

type Schema = {
  properties: Record<string, { type?: string; enum?: unknown[]; properties?: Record<string, unknown>; required?: string[] }>;
  required?: string[];
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the signature tools in tools/list (#608)', () => {
  it('are not listed while the flag is off, or while the legacy renderer draws letters', async () => {
    for (const [flag, renderer] of [['', 'pdf'], ['false', 'pdf'], ['ture', 'pdf'], ['true', 'html'], ['true', '']]) {
      vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', flag);
      vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
      expect(await listed(), `${flag}/${renderer}`).toEqual([]);
    }
  });

  it('are listed while offered, with what each takes and how each is annotated', async () => {
    vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
    const tools = await listed();
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual([...TOOLS].sort());

    const set = byName.set_signature.inputSchema as Schema;
    expect(Object.keys(set.properties).sort()).toEqual(['image', 'imageUrl']);
    expect(set.required ?? []).toEqual([]);
    // ChatGPT fills a file parameter by this shape.
    expect(Object.keys(set.properties.image.properties ?? {}).sort()).toEqual(['download_url', 'file_id', 'file_name', 'mime_type']);
    expect(byName.set_signature._meta).toMatchObject({ 'openai/fileParams': ['image'] });
    expect(Object.keys((byName.get_signature.inputSchema as Schema).properties ?? {})).toEqual([]);
    expect((byName.clear_signature.inputSchema as Schema).required).toEqual(['confirm']);

    // The picture is not in any output schema: it travels in _meta.
    for (const name of ['set_signature', 'get_signature']) {
      expect(Object.keys((byName[name].outputSchema as Schema).properties), name).not.toContain('signatureImage');
    }

    expect(byName.set_signature.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(byName.get_signature.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.clear_signature.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it('save and remove on mail:draft, and read on mail:read, as the return address does', () => {
    expect(getRequiredToolScopes('set_signature')).toEqual(['mail:draft']);
    expect(getRequiredToolScopes('clear_signature')).toEqual(['mail:draft']);
    expect(getRequiredToolScopes('get_signature')).toEqual(['mail:read']);
  });
});

describe('the signature tools in /manifest.json (#608)', () => {
  const names = () => (buildManifest().tools as Array<{ name: string }>).map(tool => tool.name);

  it('are listed as tools/list lists them', () => {
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
    vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', '');
    for (const name of TOOLS) expect(names(), name).not.toContain(name);
    vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', 'true');
    for (const name of TOOLS) expect(names(), name).toContain(name);
  });
});

describe("a saved signature's picture (#608)", () => {
  const picture = 'data:image/png;base64,iVBORw0KGgo=';

  it('goes to the card in _meta, and never to the model', () => {
    const { structuredContent, _meta } = partitionToolResult({
      saved: true,
      replaced: false,
      width: 300,
      height: 90,
      signatureImage: picture,
      message: 'Saved the signature.'
    });
    expect(structuredContent).toEqual({ saved: true, replaced: false, width: 300, height: 90, message: 'Saved the signature.' });
    expect(_meta).toMatchObject({ signatureImage: picture });
  });

  it("is never in the text: each tool's text is its sentence", () => {
    for (const name of TOOLS) {
      expect(summarizeToolResult(name, { message: 'A signature is saved.', signatureImage: picture }), name).toBe('A signature is saved.');
    }
  });
});

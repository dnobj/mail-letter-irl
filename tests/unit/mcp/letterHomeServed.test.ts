import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/auth/identity.js', () => ({ prepareAuthenticatedUser: vi.fn().mockResolvedValue('owner@example.test') }));
vi.mock('../../../src/db/index.js', () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
vi.mock('../../../src/store/fileAccountStore.js', () => ({ FileAccountStore: class {
  async getOrCreate(userId: string) { return { userId, creditsRemaining: 0, orders: [] }; }
} }));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLetterTools } from '../../../src/mcp/registerTools.js';
import { LetterIrlServer } from '../../../src/server.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { getRequiredToolScopes } from '../../../src/auth/toolScopes.js';
import { query } from '../../../src/db/index.js';
import { openLetterHomeInputZ, openLetterHomeOutputZ } from '../../../src/zodSchemas.js';
import { openLetterHomeInputSchema, openLetterHomeOutputSchema } from '../../../src/schemas.js';
import { toolInputSchemas } from '../../../src/mcp/toolSchemas.js';

const connections: Array<{ server: McpServer; client: Client }> = [];
async function connect(scopes = ['mail:read'], userId = 'auth0|owner') {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_BETA_GATE_ENABLED', 'false');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
  const server = new McpServer({ name: 'home-wire', version: '0.0.0' });
  await registerLetterTools(server, new LetterIrlServer(), {
    userId, scopes, claims: { azp: 'https://chatgpt.com/oauth/home/client.json' }, token: 'test', authType: 'jwt'
  });
  const client = new Client({ name: 'home-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  connections.push({ server, client });
  return client;
}
afterEach(async () => {
  for (const connection of connections.splice(0)) await Promise.all([connection.client.close(), connection.server.close()]);
  vi.unstubAllEnvs(); vi.clearAllMocks();
});

describe('Letter IRL home on the MCP wire', () => {
  it('is absent from tools, resources and manifest by default', async () => {
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', 'false');
    const client = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('open_letter_home');
    expect((await client.listResources()).resources.some(resource => resource.uri.includes('LetterHomeCard'))).toBe(false);
    expect(buildManifest().tools.some(tool => tool.name === 'open_letter_home')).toBe(false);
    await expect(client.readResource({ uri: 'ui://widgets/LetterHomeCard.html@v1' })).rejects.toThrow();
  });

  it('accepts {}, dispatches the real registry, exposes the entrypoint and serves its HTML', async () => {
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', 'true');
    const client = await connect();
    const tool = (await client.listTools()).tools.find(tool => tool.name === 'open_letter_home')!;
    expect(tool.title).toBe('Letter IRL');
    expect(tool.inputSchema.properties).toEqual({});
    expect(tool._meta).toMatchObject({ 'openai/ui': { entrypoints: [{ type: 'global' }] } });
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    const result = await client.callTool({ name: 'open_letter_home', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ drafts: [], orders: [], recipients: [], limit: 20 });
    expect(vi.mocked(query).mock.calls.at(-1)?.[1]).toEqual(['auth0|owner', 20]);
    const uri = (tool._meta?.ui as { resourceUri: string }).resourceUri;
    const resource = await client.readResource({ uri });
    expect(resource.contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect((resource.contents[0] as { text: string }).text).toContain('Ready to finish');
    expect(buildManifest().tools.find(tool => tool.name === 'open_letter_home')?.outputSchema).toEqual(openLetterHomeOutputSchema);
    expect(buildManifest().ui.widgets).toContain('LetterHomeCard');
  });

  it('requires mail:read and never executes a caller without it', async () => {
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', 'true');
    expect(getRequiredToolScopes('open_letter_home')).toEqual(['mail:read']);
    const client = await connect(['mail:draft']);
    const result = await client.callTool({ name: 'open_letter_home', arguments: {} });
    expect(result.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('checks the flag again for a connection holding a cached tool list', async () => {
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', 'true');
    const client = await connect();
    vi.stubEnv('LETTER_IRL_HOME_ENABLED', 'false');
    const result = await client.callTool({ name: 'open_letter_home', arguments: {} });
    expect(result.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps empty arguments and output properties coherent across all schema layers', () => {
    expect(openLetterHomeInputZ.parse({})).toEqual({});
    expect(toolInputSchemas.open_letter_home.parse({})).toEqual({});
    expect(openLetterHomeInputSchema.properties).toEqual({});
    expect(Object.keys(openLetterHomeOutputZ.shape).sort()).toEqual(Object.keys(openLetterHomeOutputSchema.properties as object).sort());
    expect(openLetterHomeInputZ.safeParse({ userId: 'other' }).success).toBe(false);
  });
});

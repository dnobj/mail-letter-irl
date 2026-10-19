import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The first test pays for importing the whole server module graph (see betaRefusalResponse.test.ts).
vi.setConfig({ testTimeout: 60_000 });

const profileOverride = vi.hoisted(() => ({ name: 'chatgpt' as string }));
vi.mock('../../../src/auth/clientProfiles.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/auth/clientProfiles.js')>();
  return {
    ...actual,
    resolveClientProfile: () => actual.clientProfileNamed(profileOverride.name as never)
  };
});

// The account is fine: no database here.
vi.mock('../../../src/auth/identity.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/auth/identity.js')>()),
  prepareAuthenticatedUser: vi.fn(async () => undefined)
}));

// The options each server is made with, as the SDK is given them.
const serverOptions = vi.hoisted(() => [] as Array<Record<string, unknown> | undefined>);
vi.mock('@modelcontextprotocol/server', async importOriginal => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  class McpServer extends actual.McpServer {
    constructor(...args: ConstructorParameters<typeof actual.McpServer>) {
      super(...args);
      serverOptions.push(args[1] as Record<string, unknown> | undefined);
    }
  }
  return { ...actual, McpServer };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLetterMcpHandler, MCP_CACHE_HINTS } from '../../../src/mcp/httpServer.js';
import { hostOrOriginRefusal, toSdkAuthInfo, userFromSdkAuthInfo } from '../../../src/mcp/mcpEndpoint.js';
import { LetterIrlServer } from '../../../src/server.js';
import type { AuthenticatedUser } from '../../../src/auth/tokenValidator.js';

/**
 * /mcp on SDK v2 (#477): one handler serves the 2026-07-28 revision and, statelessly, the 2025 one, from one
 * factory; what SDK v1's transport checked before it is checked in front of it.
 */

const USER: AuthenticatedUser = {
  userId: 'auth0|endpoint',
  claims: { azp: 'chatgpt-client' },
  token: 'token',
  authType: 'jwt',
  scopes: ['mail:read', 'mail:draft', 'mail:send']
};

describe('the Host and Origin check in front of the handler', () => {
  const HOSTS = ['api.example.test', 'localhost:8090'];
  const ORIGINS = ['https://chatgpt.com'];

  it('lets a listed Host through, with no Origin or a listed one', () => {
    expect(hostOrOriginRefusal({ host: 'api.example.test' }, HOSTS, ORIGINS)).toBeNull();
    expect(hostOrOriginRefusal({ host: 'localhost:8090', origin: 'https://chatgpt.com' }, HOSTS, ORIGINS)).toBeNull();
  });

  it('refuses a missing or unlisted Host as SDK v1 did: exact strings, port included', () => {
    for (const headers of [{}, { host: 'evil.example' }, { host: 'localhost' }, { host: 'API.example.test' }]) {
      const refused = hostOrOriginRefusal(headers, HOSTS, ORIGINS);
      expect(refused?.reason, JSON.stringify(headers)).toBe('host');
      expect(refused?.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: `Invalid Host header: ${(headers as { host?: string }).host}` }, id: null });
    }
  });

  it('refuses an unlisted Origin when one is sent', () => {
    const refused = hostOrOriginRefusal({ host: 'api.example.test', origin: 'https://evil.example' }, HOSTS, ORIGINS);
    expect(refused).toEqual({
      reason: 'origin',
      body: { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid Origin header: https://evil.example' }, id: null }
    });
  });

  it('checks the Host before the Origin, and nothing when no list is set', () => {
    expect(hostOrOriginRefusal({ host: 'evil.example', origin: 'https://evil.example' }, HOSTS, ORIGINS)?.reason).toBe('host');
    expect(hostOrOriginRefusal({ host: 'evil.example', origin: 'https://evil.example' }, [], [])).toBeNull();
  });
});

describe('the caller handed to the server factory', () => {
  it('goes over as the SDK names it and comes back as it went', () => {
    const info = toSdkAuthInfo(USER);
    expect(info).toMatchObject({ token: 'token', clientId: 'chatgpt-client', scopes: USER.scopes });
    expect(userFromSdkAuthInfo(info)).toBe(USER);
    expect(toSdkAuthInfo({ ...USER, claims: { client_id: 'pat-client' } }).clientId).toBe('pat-client');
  });

  it('is nobody when nothing, or something else, was handed over', () => {
    expect(userFromSdkAuthInfo(undefined)).toBeNull();
    expect(userFromSdkAuthInfo({ token: 't', clientId: 'c', scopes: [] })).toBeNull();
    expect(userFromSdkAuthInfo({ token: 't', clientId: 'c', scopes: [], extra: { user: { userId: 7 } } })).toBeNull();
  });
});

describe('caching for 2026-07-28 clients', () => {
  it('lets no list or read be kept, or shared with another caller', () => {
    expect(Object.keys(MCP_CACHE_HINTS).sort()).toEqual([
      'prompts/list',
      'resources/list',
      'resources/read',
      'resources/templates/list',
      'server/discover',
      'tools/list'
    ]);
    for (const hint of Object.values(MCP_CACHE_HINTS)) expect(hint).toEqual({ ttlMs: 0, cacheScope: 'private' });
  });

  it('gives every server those hints, not the SDK default, which could change', async () => {
    serverOptions.length = 0;
    const handler = createLetterMcpHandler(new LetterIrlServer());
    await handler.fetch(
      new Request('http://localhost:8090/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      }),
      { authInfo: toSdkAuthInfo(USER) }
    );
    await handler.close();
    expect(serverOptions.length).toBeGreaterThan(0);
    for (const options of serverOptions) expect(options?.cacheHints).toBe(MCP_CACHE_HINTS);
  });
});

describe('the order /mcp checks a request in', () => {
  it('limits, signs in, limits the account, checks Host and Origin, and only then hands the request to the SDK', () => {
    const source = readFileSync(join(process.cwd(), 'src/mcp/httpServer.ts'), 'utf8');
    const steps = [
      "rateLimitMiddlewareWithTier(req, res, 'mcp')",
      'authenticateRequest(req, res, getPublicBaseUrl(req))',
      "rateLimitMiddlewareWithTier(req, res, 'mcp_account')",
      'hostOrOriginRefusal(req.headers, allowedHosts, allowedOrigins)',
      'if (refused) {',
      'await serveMcp(forwarded, res, parsedBody)'
    ];
    const at = steps.map(step => source.indexOf(step));
    expect(at.every(index => index > 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Each step is there once: the handler has one way in.
    for (const step of steps.slice(3)) expect(source.split(step).length, step).toBe(2);
    // A refusal is answered, and goes no further.
    const refusal = source.slice(source.indexOf('if (refused) {'), source.indexOf('}', source.indexOf('res.end(JSON.stringify(refused.body))')));
    expect(refusal).toMatch(/res\.writeHead\(403, \{ "Content-Type": "application\/json" \}\);\s*res\.end\(JSON\.stringify\(refused\.body\)\);\s*return;/);
  });
});

describe('one handler, both protocol revisions', () => {
  beforeEach(() => {
    vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
    vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
    profileOverride.name = 'chatgpt';
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A real v2 client, speaking one revision, to the handler /mcp mounts, with the caller /mcp signed in. */
  async function connect(mode: 'legacy' | { pin: string }) {
    const handler = createLetterMcpHandler(new LetterIrlServer());
    const seen: Array<{ method: string; version: string | null; answer?: Promise<unknown> }> = [];
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8090/mcp'), {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const response = await handler.fetch(request, { authInfo: toSdkAuthInfo(USER) });
        const answer = response.headers.get('content-type')?.includes('json') ? response.clone().json() : undefined;
        seen.push({ method: body?.method ?? request.method, version: request.headers.get('mcp-protocol-version'), answer });
        return response;
      }
    });
    const client = new Client({ name: 'endpoint-test', version: '0.0.0' }, { versionNegotiation: { mode } });
    await client.connect(transport);
    return { client, handler, seen };
  }

  it('serves a 2025 client its handshake, then each request on its own', async () => {
    const { client, handler, seen } = await connect('legacy');
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toContain('quote_and_preview_letter');
    expect(seen[0]).toMatchObject({ method: 'initialize' });
    expect(seen.find(entry => entry.method === 'tools/list')?.version).toBe('2025-11-25');
    expect(client.getInstructions()).toMatch(/Letter IRL/);
    await client.close();
    await handler.close();
  });

  it('serves a 2026-07-28 client discover, its own app\'s instructions, and private lists', async () => {
    const { client, handler, seen } = await connect({ pin: '2026-07-28' });
    expect(seen.some(entry => entry.method === 'initialize')).toBe(false);
    expect(seen[0]).toMatchObject({ method: 'server/discover' });
    expect(client.getInstructions()).toMatch(/Letter IRL/);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain('quote_and_preview_letter');
    // On the wire: kept by nobody, shared with nobody.
    for (const method of ['server/discover', 'tools/list']) {
      const answer = (await seen.find(entry => entry.method === method)?.answer) as { result?: Record<string, unknown> };
      expect(answer?.result, method).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
    }
    await client.close();
    await handler.close();
  });

  it('serves both revisions the same tools, schemas and metadata', async () => {
    const legacy = await connect('legacy');
    const modern = await connect({ pin: '2026-07-28' });
    const [old, current] = await Promise.all([legacy.client.listTools(), modern.client.listTools()]);
    expect(current.tools).toEqual(old.tools);
    for (const side of [legacy, modern]) {
      await side.client.close();
      await side.handler.close();
    }
  });

  // SDK v2 moved a request's _meta from extra._meta to ctx.mcpReq._meta: the phone's user agent must still arrive.
  it.each([['2025', 'legacy' as const], ['2026-07-28', { pin: '2026-07-28' }]])(
    'hands a tool the phone ChatGPT says it runs on (%s)',
    async (_label, mode) => {
      const execute = vi.spyOn(LetterIrlServer.prototype, 'execute').mockResolvedValue({ result: { message: 'ok' }, meta: {} } as never);
      const { client, handler } = await connect(mode);
      await client.callTool({ name: 'get_account_balance', arguments: {}, _meta: { 'openai/userAgent': 'ChatGPT/1.2026.220 (Android 16; Pixel 9)' } });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'get_account_balance', isMobile: true }));
      execute.mockRestore();
      await client.close();
      await handler.close();
    }
  );

  it('answers a GET or a DELETE with 405: nothing is held between requests', async () => {
    const handler = createLetterMcpHandler(new LetterIrlServer());
    for (const method of ['GET', 'DELETE']) {
      const response = await handler.fetch(new Request('http://localhost:8090/mcp', { method }), { authInfo: toSdkAuthInfo(USER) });
      expect(response.status, method).toBe(405);
    }
    await handler.close();
  });
});

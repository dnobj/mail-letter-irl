import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import type { ClientProfile } from '../../../src/auth/clientProfiles.js';
import { LetterIrlServer } from '../../../src/server.js';
import {
  createPackCheckoutInputZ,
  saveStationeryDesignInputZ,
  setMailServiceInputZ,
  setStationeryThemeRequiredZ
} from '../../../src/zodSchemas.js';

/**
 * A required choice names its options when it is missing (#681). From MCP SDK 1.31 a missing field is refused as
 * "Required" alone; zod's message for a wrong value already lists the options, so a missing one says them too.
 */
describe('required choices name their options when missing', () => {
  const issueFor = (schema: z.ZodType, input: unknown, field: string) => {
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    return parsed.error!.issues.find(issue => issue.path[0] === field)!.message;
  };

  it('the mail service', () => {
    expect(issueFor(setMailServiceInputZ, { draftId: 'draft-1' }, 'mailService')).toBe(
      'Required: one of standard, certified, certified_return_receipt'
    );
  });

  it('the pack to buy', () => {
    expect(issueFor(createPackCheckoutInputZ, {}, 'pack')).toBe('Required: one of starter, regular, power');
  });

  it("a saved design's face, ornament and tone", () => {
    const input = { name: 'Garden', ruled: true };
    expect(issueFor(saveStationeryDesignInputZ, input, 'face')).toMatch(/^Required: one of serif, typewriter, handwritten$/);
    expect(issueFor(saveStationeryDesignInputZ, input, 'ornament')).toMatch(/^Required: one of none, /);
    expect(issueFor(saveStationeryDesignInputZ, input, 'tone')).toMatch(/^Required: one of black, /);
  });

  it("set_stationery's stationery, as served while saved designs are off", () => {
    const parsed = setStationeryThemeRequiredZ.safeParse(undefined);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0].message).toMatch(/^Required: one of classic, monogram, /);
  });

  it('still names the options for a wrong value, and takes a right one', () => {
    // A wrong value is not called missing: zod's own message says it is not one of them.
    expect(issueFor(createPackCheckoutInputZ, { pack: 'huge' }, 'pack')).toMatch(/^Invalid option: expected one of .*starter.*regular.*power/);
    expect(createPackCheckoutInputZ.safeParse({ pack: 'starter' }).success).toBe(true);
  });
});

describe('what a model is told for a missing choice, through the MCP server (#681)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A connection whose tools are the real ones, and whose app stops before doing anything. */
  async function call(name: string, arguments_: Record<string, unknown>) {
    vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
    vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid email offline_access mail:read mail:draft mail:send');
    const real = new LetterIrlServer();
    const execute = vi.fn(async () => {
      throw new Error('stopped before the tool');
    });
    const appServer = { listTools: (client: ClientProfile) => real.listTools(client), execute } as unknown as LetterIrlServer;
    const server = await createMcpServer(appServer, {
      userId: 'auth0|test',
      claims: { azp: 'https://chatgpt.com/oauth/abc/client.json' },
      token: 'token',
      authType: 'jwt',
      scopes: ['mail:read', 'mail:draft', 'mail:send']
    });
    const client = new Client({ name: 'required-choices', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const outcome = await client.callTool({ name, arguments: arguments_ }).catch(error => error);
    expect(execute).not.toHaveBeenCalled();
    return JSON.stringify(outcome);
  }

  it('set_stationery without stationery', async () => {
    vi.stubEnv('LETTER_IRL_STATIONERY_ENABLED', 'true');
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
    expect(await call('set_stationery', { draftId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0' })).toContain(
      'Required: one of classic, monogram'
    );
  });

  it('create_pack_checkout without pack', async () => {
    expect(await call('create_pack_checkout', {})).toContain('Required: one of starter, regular, power');
  });
});

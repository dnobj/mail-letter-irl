/**
 * get_draft_status as tools/list and /manifest.json serve it, and as its output
 * schema parses what the tool answers (#625): the card-only tool says how a
 * ready letter travels now (the certified service) and in what words (the
 * delivery class and its disclaimer), so a card shown its preview again can
 * draw the change. The schemas are closed: a field the handler answers with and
 * the served schema does not declare is lost, and one the manifest does not
 * declare drifts from what is served.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { getZodOutputShape } from '../../../src/mcp/registerTools.js';
import type { ClientProfile } from '../../../src/auth/clientProfiles.js';
import { LetterIrlServer } from '../../../src/server.js';
import { CERTIFIED_DELIVERY_CLASS, CERTIFIED_DELIVERY_DISCLAIMER } from '../../../src/content/delivery.js';

type Schema = { required?: string[]; properties: Record<string, { type?: string; enum?: string[]; description?: string }> };

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
  const client = new Client({ name: 'draft-status-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return (await client.listTools()).tools;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const FIELDS = ['mailService', 'deliveryClass', 'deliveryDisclaimer'] as const;

describe('get_draft_status declares how a ready letter travels (#625)', () => {
  it('serves the service and the delivery words, and the manifest declares them the same way', async () => {
    const served = (await listed()).find(tool => tool.name === 'get_draft_status')!.outputSchema as Schema;
    const manifest = (buildManifest().tools as unknown as Array<{ name: string; outputSchema: Schema }>).find(
      tool => tool.name === 'get_draft_status'
    )!.outputSchema;
    for (const field of FIELDS) {
      expect(served.properties[field], `${field} served`).toBeDefined();
      expect(manifest.properties[field], `${field} in the manifest`).toBeDefined();
      expect(manifest.properties[field].type, field).toBe(served.properties[field].type);
      expect(manifest.properties[field].description, field).toBe(served.properties[field].description);
    }
    expect(served.properties.mailService.enum).toEqual(['certified', 'certified_return_receipt']);
    expect(manifest.properties.mailService.enum).toEqual(['certified', 'certified_return_receipt']);
    // None is required: an ordinary letter, a postcard and an older answer have none of them.
    for (const field of FIELDS) {
      expect(served.required ?? [], field).not.toContain(field);
      expect(manifest.required ?? [], field).not.toContain(field);
    }
  });

  it('keeps what the tool answers for a ready certified letter when the served schema parses it', () => {
    const answer = {
      draftId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0',
      status: 'ready',
      mailService: 'certified',
      deliveryClass: CERTIFIED_DELIVERY_CLASS,
      deliveryDisclaimer: CERTIFIED_DELIVERY_DISCLAIMER
    };
    const parsed = z.object(getZodOutputShape('get_draft_status')!).safeParse(answer);
    expect(parsed.success).toBe(true);
    // A field the schema did not declare would be stripped here, and refused by a closed schema in a host.
    expect(parsed.success ? parsed.data : {}).toMatchObject({
      mailService: 'certified',
      deliveryClass: CERTIFIED_DELIVERY_CLASS,
      deliveryDisclaimer: CERTIFIED_DELIVERY_DISCLAIMER
    });
  });

  it('refuses a service that is not one of the two certified ones', () => {
    const shape = z.object(getZodOutputShape('get_draft_status')!);
    expect(shape.safeParse({ draftId: 'd', status: 'ready', mailService: 'standard' }).success).toBe(false);
    expect(shape.safeParse({ draftId: 'd', status: 'ready', mailService: 'express' }).success).toBe(false);
    expect(shape.safeParse({ draftId: 'd', status: 'ready', mailService: 'certified_return_receipt' }).success).toBe(true);
  });
});

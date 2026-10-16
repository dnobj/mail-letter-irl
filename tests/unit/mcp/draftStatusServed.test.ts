/**
 * Every answer that carries a letter's terms (get_draft_status, set_stationery, set_letter_words,
 * set_letter_signature and set_mail_service) says how the letter travels with
 * them (#625): the certified service and the words that say how it is delivered,
 * so a card that takes the terms of an answer takes these with it. The schemas
 * are closed: a field a handler answers with and the served schema does not
 * declare is lost to ChatGPT, and one the manifest does not declare drifts from
 * what is served.
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
// Every answer that carries a letter's terms says how the letter travels with them (#625).
const TOOLS = ['get_draft_status', 'set_stationery', 'set_letter_words', 'set_letter_signature', 'set_mail_service'] as const;

// All five are listed only while their feature is offered.
const offerEverything = () => {
  for (const [name, value] of Object.entries({
    LETTER_IRL_PRINT_RENDERER: 'pdf',
    LETTER_IRL_STATIONERY_ENABLED: 'true',
    LETTER_IRL_ROOM_TO_WRITE_ENABLED: 'true',
    LETTER_IRL_SIGNATURES_ENABLED: 'true',
    LETTER_IRL_CERTIFIED_MAIL_ENABLED: 'true',
    JIT_PURCHASE_ENABLED: 'true'
  })) {
    vi.stubEnv(name, value);
  }
};

describe('the answers that carry the terms of a letter declare how it travels (#625)', () => {
  it.each(TOOLS)('%s serves the service and the delivery words, and the manifest declares them the same way', async tool => {
    offerEverything();
    const served = (await listed()).find(found => found.name === tool)!.outputSchema as Schema;
    const manifest = (buildManifest().tools as unknown as Array<{ name: string; outputSchema: Schema }>).find(found => found.name === tool)!.outputSchema;
    for (const field of FIELDS) {
      expect(served.properties[field], `${field} served`).toBeDefined();
      expect(manifest.properties[field], `${field} in the manifest`).toBeDefined();
      expect(manifest.properties[field].type, field).toBe(served.properties[field].type);
      expect(manifest.properties[field].description, field).toBe(served.properties[field].description);
      // None is required: an ordinary letter, a postcard and an older answer have none of them.
      expect(served.required ?? [], field).not.toContain(field);
      expect(manifest.required ?? [], field).not.toContain(field);
    }
    expect(served.properties.mailService.enum).toEqual(['certified', 'certified_return_receipt']);
    expect(manifest.properties.mailService.enum).toEqual(['certified', 'certified_return_receipt']);
  });

  it.each(TOOLS)('%s keeps what it answers for a certified letter when the served schema parses it', tool => {
    const answer = { mailService: 'certified', deliveryClass: CERTIFIED_DELIVERY_CLASS, deliveryDisclaimer: CERTIFIED_DELIVERY_DISCLAIMER };
    // Partial: the other fields of each answer are theirs; what matters here is that these three are declared, not stripped.
    const parsed = z.object(getZodOutputShape(tool)!).partial().safeParse(answer);
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : {}).toMatchObject(answer);
  });

  it.each(TOOLS)('%s refuses a service that is not one of the two certified ones', tool => {
    const shape = z.object(getZodOutputShape(tool)!).partial();
    expect(shape.safeParse({ mailService: 'standard' }).success).toBe(false);
    expect(shape.safeParse({ mailService: 'express' }).success).toBe(false);
    expect(shape.safeParse({ mailService: 'certified_return_receipt' }).success).toBe(true);
  });
});

describe('the steering revision after how a letter travels (#625)', () => {
  it('is bumped, so a client holding the earlier tool list can be told apart in the log', async () => {
    const { STEERING_COPY_REV } = await import('../../../src/mcp/steeringRev.js');
    expect(STEERING_COPY_REV).toBeGreaterThanOrEqual(41);
  });
});

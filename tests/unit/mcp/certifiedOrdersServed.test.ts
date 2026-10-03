/**
 * Certified orders as tools/list and /manifest.json serve them (#625): the
 * output schemas of get_order_status and list_orders declare the service, the
 * USPS number and its link whatever the flag says (the output schemas are
 * closed, and a sent letter is a fact that outlives the flag), and the
 * narration says what an order has to say about its certified mail.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue('person@example.com')
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../../src/mcp/httpServer.js';
import { buildManifest } from '../../../src/mcp/manifest.js';
import { summarizeToolResult } from '../../../src/mcp/registerTools.js';
import type { ClientProfile } from '../../../src/auth/clientProfiles.js';
import { LetterIrlServer } from '../../../src/server.js';
import { STEERING_COPY_REV } from '../../../src/mcp/steeringRev.js';

type Field = { type?: string; enum?: string[]; description?: string };
type Schema = { properties: Record<string, Field & { items?: Schema }> };

async function listed(names: readonly string[]) {
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
  const client = new Client({ name: 'certified-orders-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return tools.filter(tool => names.includes(tool.name));
}

const manifestTools = (names: readonly string[]) =>
  (buildManifest().tools as unknown as Array<{ name: string; outputSchema?: Schema }>).filter(tool => names.includes(tool.name));

const SERVICES = ['certified', 'certified_return_receipt'];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the order tools' certified output (#625)", () => {
  it('is declared in get_order_status whatever the flag says, on both layers', async () => {
    const outputs: Schema[] = [];
    for (const flag of ['', 'true']) {
      vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', flag);
      vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
      outputs.push(...(await listed(['get_order_status'])).map(tool => tool.outputSchema as Schema));
    }
    outputs.push(...manifestTools(['get_order_status']).map(tool => tool.outputSchema as Schema));
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(output.properties.mailService.enum).toEqual(SERVICES);
      expect(output.properties.carrierTrackingNumber.type).toBe('string');
      expect(output.properties.carrierTrackingNumber.description).toContain('not the order id');
      expect(output.properties.carrierTrackingUrl.type).toBe('string');
      expect(output.properties.certifiedNote.type).toBe('string');
    }
  });

  it("is declared in list_orders' entries whatever the flag says, on both layers", async () => {
    const outputs: Schema[] = [];
    for (const flag of ['', 'true']) {
      vi.stubEnv('LETTER_IRL_CERTIFIED_MAIL_ENABLED', flag);
      vi.stubEnv('JIT_PURCHASE_ENABLED', 'true');
      outputs.push(...(await listed(['list_orders'])).map(tool => tool.outputSchema as Schema));
    }
    outputs.push(...manifestTools(['list_orders']).map(tool => tool.outputSchema as Schema));
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      const entry = output.properties.orders.items as Schema;
      expect(entry.properties.mailService.enum).toEqual(SERVICES);
      expect(entry.properties.carrierTrackingNumber.type).toBe('string');
      expect(entry.properties.carrierTrackingUrl.type).toBe('string');
    }
  });

  it('adds nothing to either tool\'s description or input', async () => {
    const [status, list] = [...(await listed(['get_order_status'])), ...(await listed(['list_orders']))];
    for (const tool of [status, list]) {
      expect(tool.description ?? '').not.toMatch(/certified/i);
    }
    expect(Object.keys((status.inputSchema as Schema).properties)).toEqual(['orderId']);
    expect(Object.keys((list.inputSchema as Schema).properties)).toEqual(['limit']);
  });

  it('says the note after the status, and nothing for an ordinary order', () => {
    expect(summarizeToolResult('get_order_status', { currentStatus: 'in_transit' })).toBe('Latest order status: in_transit.');
    expect(summarizeToolResult('get_order_status', { currentStatus: 'in_transit', certifiedNote: 'Sent as USPS Certified Mail. X.' })).toBe(
      'Latest order status: in_transit. Sent as USPS Certified Mail. X.'
    );
    expect(
      summarizeToolResult('get_order_status', {
        currentStatus: 'scheduled',
        arriveBy: '2026-10-16',
        mailOn: '2026-10-06',
        cancellable: true,
        certifiedNote: 'Sent as USPS Certified Mail. X.'
      })
    ).toMatch(/^Latest order status: scheduled\. .* Sent as USPS Certified Mail\. X\.$/);
  });

  it('counts the certified orders in a list, and says where their numbers are', () => {
    const say = (orders: unknown[]) => summarizeToolResult('list_orders', { orders, total: orders.length });
    expect(say([{ orderId: 'a' }, { orderId: 'b' }])).toBe('Found 2 recent orders (2 total).');
    expect(say([{ orderId: 'a', mailService: 'certified' }, { orderId: 'b' }, { orderId: 'c', mailService: 'certified_return_receipt' }])).toBe(
      'Found 3 recent orders (3 total). 2 went as USPS Certified Mail: their entries carry the USPS tracking number and link once there is one.'
    );
  });

  it('bumps the steering copy revision', () => {
    expect(STEERING_COPY_REV).toBeGreaterThanOrEqual(39);
  });
});

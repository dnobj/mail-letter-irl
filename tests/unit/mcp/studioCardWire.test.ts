/**
 * The studio card's switch on the wire (#580): a letter preview's result
 * carries letterirl/studioCard in _meta while the flag is on, never in
 * structuredContent, and no other tool's does. The registered handler is
 * called directly, as envelopeRevealWire.test.ts does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/identity.js', () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue(undefined)
}));

import { registerLetterTools } from '../../../src/mcp/registerTools.js';

type Handler = (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<any>;

async function registered(name: string) {
  vi.stubEnv('LETTER_IRL_REQUIRE_AUTH', 'true');
  vi.stubEnv('LETTER_IRL_OAUTH_SCOPES', 'openid profile email mail:read mail:draft mail:send');
  let callback: Handler | undefined;
  const mcpServer = {
    registerResource: vi.fn(),
    registerTool: vi.fn((registeredName: string, _definition: unknown, handler: Handler) => {
      if (registeredName === name) callback = handler;
    })
  };
  const appServer = {
    listTools: () => [{ name, description: 'A preview', readOnly: false, meta: {} }],
    execute: vi.fn(async () => ({ result: { draftId: 'draft-1', previewHtml: '<html>page</html>', lettersRequired: 1 }, meta: {} }))
  };
  await registerLetterTools(mcpServer as any, appServer as any, {
    userId: 'auth0|test',
    claims: {},
    token: 'token',
    authType: 'jwt' as const,
    scopes: ['mail:read', 'mail:draft', 'mail:send']
  });
  expect(callback, name).toBeDefined();
  return callback!;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the studio card's switch on the wire (#580)", () => {
  it("rides every preview's _meta while on, beside its page, and never reaches the model", async () => {
    vi.stubEnv('LETTER_IRL_STUDIO_CARD_ENABLED', 'true');
    for (const name of [
      'quote_and_preview_letter',
      'quote_and_preview_letter_with_header_image',
      'quote_and_preview_letter_with_image',
      'quote_and_preview_postcard'
    ]) {
      const result = await (await registered(name))({}, {});
      expect(result._meta, name).toMatchObject({ 'letterirl/studioCard': true, previewHtml: '<html>page</html>' });
      expect(result.structuredContent).not.toHaveProperty('letterirl/studioCard');
    }
  });

  it('is absent while off', async () => {
    vi.stubEnv('LETTER_IRL_STUDIO_CARD_ENABLED', '');
    for (const name of ['quote_and_preview_letter', 'quote_and_preview_postcard']) {
      const off = await (await registered(name))({}, {});
      expect(off._meta, name).not.toHaveProperty('letterirl/studioCard');
    }
  });
});

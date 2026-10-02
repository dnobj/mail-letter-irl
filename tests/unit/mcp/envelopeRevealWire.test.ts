/**
 * The envelope reveal's switch on the wire (#576): a letter preview's result
 * carries letter-irl/envelopeReveal in _meta while the flag is on, never in
 * structuredContent, and no other tool's does. The registered handler is
 * called directly, as duplicateMailRefusal.test.ts does.
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

describe("the envelope reveal's switch on the wire (#576)", () => {
  it("rides a letter preview's _meta while on, beside its page, and never reaches the model", async () => {
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', 'true');
    for (const name of ['quote_and_preview_letter', 'quote_and_preview_letter_with_header_image', 'quote_and_preview_letter_with_image']) {
      const result = await (await registered(name))({}, {});
      expect(result._meta, name).toMatchObject({ 'letter-irl/envelopeReveal': true, previewHtml: '<html>page</html>' });
      expect(result.structuredContent).not.toHaveProperty('letter-irl/envelopeReveal');
    }
  });

  it("is absent while off, and from a postcard's result", async () => {
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', '');
    const off = await (await registered('quote_and_preview_letter'))({}, {});
    expect(off._meta).not.toHaveProperty('letter-irl/envelopeReveal');
    vi.stubEnv('LETTER_IRL_ENVELOPE_REVEAL_ENABLED', 'true');
    const postcard = await (await registered('quote_and_preview_postcard'))({}, {});
    expect(postcard._meta).not.toHaveProperty('letter-irl/envelopeReveal');
  });
});

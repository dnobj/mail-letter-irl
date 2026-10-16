import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OAUTH_NOT_CONFIGURED } from '../../../src/auth/oauthErrors.js';

/**
 * Four callers answer "the server cannot validate tokens" with 503 by comparing
 * the thrown message: the REST middleware, the checkout middleware, the token
 * routes and the MCP transport. Two of them are tested only through mocks that
 * inject the literal, so a reworded throw would have left their tests green
 * while they fell back to 401 - on MCP, a challenge that loops the client
 * through authorization. The message now lives in one constant, and this pins
 * that no copy of the literal comes back anywhere in src.
 */

describe('the not-configured message', () => {
  it('is written out once, in the constant every caller compares against', () => {
    const root = join(__dirname, '../../../src');
    const holders = (readdirSync(root, { recursive: true }) as string[])
      .filter(name => name.endsWith('.ts'))
      .filter(name => readFileSync(join(root, name), 'utf8').includes(OAUTH_NOT_CONFIGURED))
      .map(name => name.replace(/\\/g, '/'));

    expect(holders).toEqual(['auth/oauthErrors.ts']);
  });
});

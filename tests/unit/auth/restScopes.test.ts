import { describe, expect, it } from 'vitest';
import { PRODUCT_SCOPES } from '../../../src/auth/oauthConfig.js';
import {
  findRestRoute,
  REST_ROUTE_SCOPES,
  requiredRestScopes
} from '../../../src/auth/restScopes.js';
import { TOOL_SCOPES } from '../../../src/auth/toolScopes.js';

/**
 * Every REST route requires the scope its MCP twin requires (audit A-03).
 *
 * A twin does the same thing through the same service, so a narrower scope on
 * one surface would let a token do over REST what MCP refuses it. Since the
 * website moved onto the MCP audience, the same tokens reach both.
 */

describe('REST route scopes', () => {
  it('gives every twin route exactly the scope its MCP tool requires', () => {
    const twinned = REST_ROUTE_SCOPES.filter(route => route.twin !== undefined);
    expect(twinned.length).toBeGreaterThan(0);
    for (const route of twinned) {
      const toolScope = TOOL_SCOPES[route.twin as string];
      expect(toolScope, `${route.id} names ${route.twin}, which is not a tool`).toBeDefined();
      expect(route.scope, `${route.id} drifted from ${route.twin}`).toBe(toolScope);
    }
  });

  it.each([
    ['GET', '/api/credits/balance', 'mail:read'],
    ['GET', '/api/credits/transactions', 'mail:read'],
    ['GET', '/api/users/me', 'mail:read'],
    ['GET', '/api/letters', 'mail:read'],
    ['GET', '/api/letters/ltr_123', 'mail:read'],
    ['GET', '/api/return-address', 'mail:read'],
    ['POST', '/api/return-address', 'mail:draft'],
    ['DELETE', '/api/return-address', 'mail:draft'],
    ['GET', '/api/promo/validate/SPRING', 'mail:read'],
    ['POST', '/api/promo/redeem', 'mail:send'],
    ['POST', '/api/stripe/create-checkout-session', 'mail:send']
  ])('%s %s requires %s', (method, path, scope) => {
    expect(requiredRestScopes(method, path)).toEqual([scope]);
  });

  it('never lets a token that cannot spend mint or revoke a personal access token', () => {
    // Minting a personal access token creates a standing credential, so it
    // takes the strongest scope (audit A-02); a token itself carries read and
    // draft only (037, #470).
    expect(requiredRestScopes('POST', '/api/tokens')).toEqual(['mail:send']);
    expect(requiredRestScopes('DELETE', '/api/tokens/42')).toEqual(['mail:send']);
    expect(requiredRestScopes('GET', '/api/tokens')).toEqual(['mail:read']);
  });

  it.each([
    ['an unknown path', 'GET', '/api/credits/unknown'],
    ['a known path with another method', 'PUT', '/api/return-address'],
    ['a letter id with an extra segment', 'GET', '/api/letters/a/b'],
    ['a token id that is not a number', 'DELETE', '/api/tokens/abc'],
    ['a request with no method', undefined, '/api/credits/balance']
  ])('fails closed for %s: every product scope is required', (_label, method, path) => {
    expect(findRestRoute(method, path)).toBeUndefined();
    expect(requiredRestScopes(method, path)).toEqual([...PRODUCT_SCOPES]);
  });

  it('names each route once, in a form the diagnostic log keeps', () => {
    const ids = REST_ROUTE_SCOPES.map(route => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9_.]{0,63}$/);
    }
  });
});

/**
 * The OAuth scope each REST route requires (audit A-03).
 *
 * The REST routes used to check only that a bearer token was valid. That was
 * harmless while no token could reach them, and stopped being harmless when
 * the website moved onto the MCP audience: a token issued to any MCP client is
 * now valid here too. So each route requires the scope its MCP twin requires,
 * and restScopes.test.ts fails if the two drift. A route with no twin takes the
 * scope of the nearest equivalent, recorded here rather than inferred.
 *
 * These routes accept only JWTs (authenticateRestRequest). Personal access
 * tokens reach MCP alone, where since #470 they carry their own scopes, read and
 * draft (migration 037), and are checked like any other token (requireScopes).
 */

import { PRODUCT_SCOPES } from './oauthConfig.js';
import type { ProductScope } from './toolScopes.js';

export interface RestRouteScope {
  /** Stable name. Also the `route` field of the rest.request diagnostic. */
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** The exact path, or a pattern for a route with an id segment. */
  readonly path: string | RegExp;
  readonly scope: ProductScope;
  /** The MCP tool that does the same thing. Its scope must equal this one. */
  readonly twin?: string;
}

export const REST_ROUTE_SCOPES: readonly RestRouteScope[] = [
  { id: 'credits.balance', method: 'GET', path: '/api/credits/balance', scope: 'mail:read', twin: 'get_account_balance' },
  { id: 'credits.balance_detailed', method: 'GET', path: '/api/credits/balance/detailed', scope: 'mail:read', twin: 'get_account_balance' },
  // No twin: read-only views of the ledger the balance comes from.
  { id: 'credits.transactions', method: 'GET', path: '/api/credits/transactions', scope: 'mail:read' },
  { id: 'credits.ledger', method: 'GET', path: '/api/credits/ledger', scope: 'mail:read' },
  // Reads the account row get_account_balance also reads.
  { id: 'users.me', method: 'GET', path: '/api/users/me', scope: 'mail:read', twin: 'get_account_balance' },
  // Grants spendable balance, like its tool.
  { id: 'promo.redeem', method: 'POST', path: '/api/promo/redeem', scope: 'mail:send', twin: 'redeem_promo_code' },
  // No twin: checking a code or listing past redemptions changes nothing.
  { id: 'promo.validate', method: 'GET', path: /^\/api\/promo\/validate\/.+$/, scope: 'mail:read' },
  { id: 'promo.redemptions', method: 'GET', path: '/api/promo/redemptions', scope: 'mail:read' },
  { id: 'letters.list', method: 'GET', path: '/api/letters', scope: 'mail:read', twin: 'list_orders' },
  { id: 'letters.get', method: 'GET', path: /^\/api\/letters\/[^/]+$/, scope: 'mail:read', twin: 'get_order_status' },
  { id: 'return_address.get', method: 'GET', path: '/api/return-address', scope: 'mail:read', twin: 'get_return_address' },
  { id: 'return_address.set', method: 'POST', path: '/api/return-address', scope: 'mail:draft', twin: 'set_return_address' },
  { id: 'return_address.clear', method: 'DELETE', path: '/api/return-address', scope: 'mail:draft', twin: 'clear_return_address' },
  // No twin. A personal access token passes every scope check, so a token that
  // could mint one with less than mail:send could escalate itself (audit A-02).
  // Revoking manages the same credential and takes the same scope.
  { id: 'tokens.list', method: 'GET', path: '/api/tokens', scope: 'mail:read' },
  { id: 'tokens.create', method: 'POST', path: '/api/tokens', scope: 'mail:send' },
  { id: 'tokens.revoke', method: 'DELETE', path: /^\/api\/tokens\/\d+$/, scope: 'mail:send' },
  { id: 'checkout.create', method: 'POST', path: '/api/stripe/create-checkout-session', scope: 'mail:send', twin: 'create_pack_checkout' },
  // The confirmation page (#470). Reading a draft is a read; pressing Send is
  // what send_letter does. Both also require the website's own application
  // (src/api/sendConfirmationApiHandler.ts).
  { id: 'sends.get', method: 'GET', path: /^\/api\/sends\/[^/]+$/, scope: 'mail:read' },
  { id: 'sends.confirm', method: 'POST', path: /^\/api\/sends\/[^/]+$/, scope: 'mail:send', twin: 'send_letter' }
];

function matches(route: RestRouteScope, method: string | undefined, pathname: string): boolean {
  if (route.method !== method) {
    return false;
  }
  return typeof route.path === 'string' ? route.path === pathname : route.path.test(pathname);
}

export function findRestRoute(method: string | undefined, pathname: string): RestRouteScope | undefined {
  return REST_ROUTE_SCOPES.find(route => matches(route, method, pathname));
}

/**
 * The scopes a request must carry. A request no row matches requires every
 * product scope: it fails closed, so a route added without a row can never be
 * reached with less than the strictest route needs. Handlers answer such a
 * request with 404 once it is admitted.
 */
export function requiredRestScopes(method: string | undefined, pathname: string): readonly ProductScope[] {
  const route = findRestRoute(method, pathname);
  return route ? [route.scope] : PRODUCT_SCOPES;
}

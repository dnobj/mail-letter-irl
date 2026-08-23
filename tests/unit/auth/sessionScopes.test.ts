/**
 * `offline_access` is advertised so Auth0 issues a refresh token, and for no
 * other reason (issue #160). It must stay a session scope: requested from the
 * authorization server, never demanded by a tool.
 *
 * The failure this guards against is quiet and nasty. If `offline_access` ever
 * joined the per-tool vocabulary - by being added to PRODUCT_SCOPES, or named
 * in TOOL_SCOPES - then every caller holding a valid token without it would
 * start failing closed with insufficient_scope. PAT callers would break
 * immediately: they authorize with no scopes at all (tokenValidator.ts returns
 * early for authType "pat"), so any tool requiring a scope they cannot obtain
 * would be permanently denied.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OAUTH_SCOPES,
  PRODUCT_SCOPES,
  SESSION_SCOPES,
  IDENTITY_SCOPES
} from '../../../src/auth/oauthConfig.js';
import { TOOL_SCOPES, getRequiredToolScopes } from '../../../src/auth/toolScopes.js';

describe('session scopes (issue #160)', () => {
  it('advertises offline_access, so Auth0 issues a refresh token', () => {
    // Without this the connection dies at access-token expiry and only a human
    // re-consent recovers it - the defect this scope exists to fix.
    expect(DEFAULT_OAUTH_SCOPES).toContain('offline_access');
    expect(SESSION_SCOPES).toContain('offline_access');
  });

  it('keeps offline_access out of the per-tool authorization vocabulary', () => {
    expect(PRODUCT_SCOPES).not.toContain('offline_access');
    expect(IDENTITY_SCOPES).not.toContain('offline_access');
  });

  it('lets no tool require a session scope', () => {
    const sessionScopes = new Set<string>(SESSION_SCOPES);
    for (const toolName of Object.keys(TOOL_SCOPES)) {
      for (const scope of getRequiredToolScopes(toolName)) {
        expect(
          sessionScopes.has(scope),
          `${toolName} requires the session scope "${scope}"; session scopes are ` +
            `requested from Auth0, not demanded of callers, and PAT callers carry no scopes at all`
        ).toBe(false);
      }
    }
  });

  it('still requires every product scope to be a real tool gate', () => {
    // The converse: a product scope nothing enforces would be advertised
    // authority with no meaning behind it.
    const enforced = new Set(
      Object.keys(TOOL_SCOPES).flatMap(toolName => getRequiredToolScopes(toolName))
    );
    for (const scope of PRODUCT_SCOPES) {
      expect(enforced.has(scope), `no tool enforces the advertised scope "${scope}"`).toBe(true);
    }
  });
});

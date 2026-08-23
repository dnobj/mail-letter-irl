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
import { buildToolSecuritySchemes } from '../../../src/mcp/registerTools.js';

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

/**
 * The channel that actually carries the request (issue #160).
 *
 * ChatGPT does not build its authorization request from `scopes_supported`.
 * It unions the `securitySchemes` scopes across the tools in scope for the
 * turn. offline_access was advertised in the protected-resource metadata, in
 * openid-configuration, and in the 401 challenge - and requested from none of
 * them, because it appeared in no tool's securitySchemes. Every Auth0 grant
 * recorded exactly "mail:draft mail:read mail:send".
 *
 * So a session scope has to be asked for per-tool while still being enforced
 * nowhere. These two tests are the halves of that, and they must both hold:
 * drop the first and no refresh token is ever issued; drop the second and PAT
 * callers are denied permanently.
 */
describe('session scopes are requested per tool but never enforced', () => {
  it('asks for every session scope on every tool', () => {
    // Every tool, not just some: a typed @-mention scopes the turn's toolset,
    // so a session scope carried by only part of the toolset would be
    // requested only on turns that happen to include one of those tools.
    for (const toolName of Object.keys(TOOL_SCOPES)) {
      const schemes = buildToolSecuritySchemes(toolName, true) as Array<{
        type: string;
        scopes?: string[];
      }>;
      const requested = schemes.flatMap(scheme => scheme.scopes ?? []);
      for (const scope of SESSION_SCOPES) {
        expect(
          requested,
          `${toolName} does not request the session scope "${scope}", so a turn ` +
            `scoped to it would authorize without one`
        ).toContain(scope);
      }
    }
  });

  it('still enforces only the product scopes it did before', () => {
    // The counterpart: asking for more must not quietly gate more.
    const sessionScopes = new Set<string>(SESSION_SCOPES);
    for (const toolName of Object.keys(TOOL_SCOPES)) {
      const enforced = getRequiredToolScopes(toolName);
      const requested = (
        buildToolSecuritySchemes(toolName, true) as Array<{ scopes?: string[] }>
      ).flatMap(scheme => scheme.scopes ?? []);

      for (const scope of enforced) {
        expect(sessionScopes.has(scope)).toBe(false);
        expect(requested).toContain(scope);
      }
      // Requested minus enforced must be exactly the session scopes - nothing
      // else may sneak into the consent screen.
      const extra = requested.filter(scope => !enforced.includes(scope));
      expect(new Set(extra)).toEqual(new Set(SESSION_SCOPES));
    }
  });

  it('requests nothing at all when auth is disabled', () => {
    const schemes = buildToolSecuritySchemes('get_account_balance', false) as Array<{
      type: string;
    }>;
    expect(schemes).toEqual([{ type: 'noauth' }]);
  });
});

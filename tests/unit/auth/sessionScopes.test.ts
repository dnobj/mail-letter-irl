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
      // Requested minus enforced must be exactly the session and identity
      // scopes - nothing else may sneak into the consent screen.
      const extra = requested.filter(scope => !enforced.includes(scope));
      expect(new Set(extra)).toEqual(new Set([...SESSION_SCOPES, ...IDENTITY_SCOPES]));
    }
  });

  it('requests nothing at all when auth is disabled', () => {
    const schemes = buildToolSecuritySchemes('get_account_balance', false) as Array<{
      type: string;
    }>;
    expect(schemes).toEqual([{ type: 'noauth' }]);
  });
});

/**
 * Identity scopes (issue #424).
 *
 * Declared on every tool since #425. What they do NOT do is worth stating
 * here, because this file is where the next reader will look: ChatGPT asks
 * for them, but Auth0 grants no OIDC scope to its CIMD client (strict
 * third-party mode), so they never produce an ID token for ChatGPT. Its
 * OAUTH_OWNER_PROFILE_ID_MISSING failure was the connector's "OIDC enabled"
 * setting, and with that off ChatGPT identifies the account through the
 * profile tool (src/tools/getProfile.ts), not through these. They stay
 * because advertising and requesting must agree, and because a client
 * registered outside strict mode can use them.
 *
 * So the two halves still have to hold, as for the session scope in #160 -
 * asked for on every tool, enforced by none - and a PAT caller, who carries no
 * scopes at all, must never be denied by one.
 */
describe('identity scopes (issue #424)', () => {
  it('asks for every identity scope on every tool', () => {
    for (const toolName of Object.keys(TOOL_SCOPES)) {
      const requested = (
        buildToolSecuritySchemes(toolName, true) as Array<{ scopes?: string[] }>
      ).flatMap(scheme => scheme.scopes ?? []);
      for (const scope of IDENTITY_SCOPES) {
        expect(
          requested,
          `${toolName} does not request the identity scope "${scope}", so a turn ` +
            `scoped to it would ask a client that honours tool scope tags for less ` +
            `than the others do`
        ).toContain(scope);
      }
    }
  });

  it('requests openid, which is the one that makes Auth0 issue an ID token', () => {
    // Named on its own because it is the one with a consequence at the
    // authorization server; email only labels the account once it exists.
    expect(IDENTITY_SCOPES).toContain('openid');
    const requested = (
      buildToolSecuritySchemes('get_account_balance', true) as Array<{ scopes?: string[] }>
    ).flatMap(scheme => scheme.scopes ?? []);
    expect(requested).toContain('openid');
  });

  it('lets no tool require an identity scope', () => {
    // The PAT half, and the reason these may never join PRODUCT_SCOPES or
    // TOOL_SCOPES: a personal access token authorizes with no scopes at all
    // (tokenValidator returns early for authType "pat"), so a tool demanding
    // openid would deny every PAT caller permanently.
    const identityScopes = new Set<string>(IDENTITY_SCOPES);
    for (const toolName of Object.keys(TOOL_SCOPES)) {
      for (const scope of getRequiredToolScopes(toolName)) {
        expect(
          identityScopes.has(scope),
          `${toolName} requires the identity scope "${scope}"; identity scopes are ` +
            `requested from Auth0, not demanded of callers, and PAT callers carry no scopes at all`
        ).toBe(false);
      }
    }
  });

  it('keeps the identity scopes out of the product vocabulary', () => {
    for (const scope of IDENTITY_SCOPES) {
      expect(PRODUCT_SCOPES).not.toContain(scope);
    }
  });

  it('asks for nothing it does not also advertise', () => {
    // Not "DEFAULT_OAUTH_SCOPES contains IDENTITY_SCOPES" - that is spread
    // from it and cannot fail. The real property is that the two channels
    // agree: the per-tool securitySchemes carry the request, DEFAULT_OAUTH_SCOPES
    // is what the metadata documents, and a scope in the first and not the
    // second is the #160 drift pointing the other way.
    //
    // The deployment-time half of this lives in oauthConfig.test.ts, because
    // LETTER_IRL_OAUTH_SCOPES can override the default and validateOAuthConfig
    // is what refuses a deployment that requests more than it advertises.
    const advertised = new Set<string>(DEFAULT_OAUTH_SCOPES);
    for (const toolName of Object.keys(TOOL_SCOPES)) {
      const requested = (
        buildToolSecuritySchemes(toolName, true) as Array<{ scopes?: string[] }>
      ).flatMap(scheme => scheme.scopes ?? []);
      for (const scope of requested) {
        expect(
          advertised.has(scope),
          `${toolName} requests "${scope}", which is not in the advertised vocabulary`
        ).toBe(true);
      }
    }
  });
});

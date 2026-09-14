import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "http";
import { generateKeyPair, SignJWT } from "jose";

/**
 * Issue #209. The REST handlers each carried their own bearer check reading
 * LETTER_IRL_OAUTH_AUDIENCE straight from the environment as a single value,
 * while the MCP layer read the audience through getOAuthConfig(). The two
 * disagreed about which audiences were valid, and every dashboard call was
 * rejected while MCP calls were fine.
 *
 * These tests pin the property that closes it: the REST check accepts exactly
 * the audience the config layer accepts, which is now the MCP resource alone.
 * The website's old audience, https://letter-irl/api, is retired, and the
 * static-DCR flag that used to merge it back in no longer does. They also pin
 * the message, because "Missing or invalid Authorization header" for a
 * present, well-formed, rejected token is what sent the #209 investigation to
 * the wrong service.
 *
 * Audit A-03 added scopes. The real validator and the real requireScopes run
 * here, so these are the tests that go red if restAuth stops checking them.
 */

vi.mock("../../../src/services/patService.js", () => ({
  TOKEN_PREFIX: "lirl_pat_",
  validateToken: vi.fn(),
  updateLastUsed: vi.fn().mockResolvedValue(undefined)
}));

// Resolve the remote JWKS to our local public key. createRemoteJWKSet is the
// only thing in the path that touches the network, and this is its seam.
let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => publicKey
  };
});

import { authenticateRestRequest } from "../../../src/api/middleware/restAuth.js";

const issuer = "https://dev-test.auth0.com/";
const mcpAudience = "https://dev-api.example.com/mcp";
const retiredAudience = "https://letter-irl/api";
const WEBSITE_SCOPE = "openid profile email offline_access mail:read mail:draft mail:send";

async function mint(
  audience: string,
  claims: Record<string, unknown> = { scope: WEBSITE_SCOPE },
  expiresIn = "5m"
): Promise<string> {
  return new SignJWT({ sub: "auth0|user-1", email: "user@example.invalid", ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

function request(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("REST bearer authentication", () => {
  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("RS256"));
  });

  beforeEach(() => {
    vi.stubEnv("LETTER_IRL_OAUTH_ISSUER", issuer);
    vi.stubEnv("LETTER_IRL_OAUTH_JWKS_URI", `${issuer}.well-known/jwks.json`);
    vi.stubEnv("LETTER_IRL_OAUTH_AUDIENCE", mcpAudience);
    vi.stubEnv("LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS", "RS256");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("accepts a token for the MCP audience, and reports the scopes it carries", async () => {
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` }),
      ["mail:read"]
    );
    expect(outcome).toEqual({
      ok: true,
      user: {
        userId: "auth0|user-1",
        email: "user@example.invalid",
        scopes: WEBSITE_SCOPE.split(" ")
      }
    });
  });

  it("rejects a token for another audience, and says so", async () => {
    // The point is the message - it must not claim the header was missing.
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(retiredAudience)}` }),
      ["mail:read"]
    );
    expect(outcome).toMatchObject({ ok: false, reason: "rejected" });
    expect(outcome.ok ? "" : outcome.message).not.toMatch(/missing/i);
  });

  it("rejects the retired website audience even with the old rollback settings in place", async () => {
    // Before the merge was removed, these two settings made this token valid.
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    vi.stubEnv("LETTER_IRL_OAUTH_LEGACY_AUDIENCES", retiredAudience);
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(retiredAudience)}` }),
      ["mail:read"]
    );
    expect(outcome).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("treats a second configured audience as a server fault, not a second accepted audience", async () => {
    // validateOAuthConfig refuses this at boot only under CIMD enforcement. The
    // validator holds the same one-audience rule on every request, so neither
    // token is accepted.
    vi.stubEnv("LETTER_IRL_OAUTH_AUDIENCE", `${mcpAudience} ${retiredAudience}`);
    for (const audience of [mcpAudience, retiredAudience]) {
      const outcome = await authenticateRestRequest(
        request({ authorization: `Bearer ${await mint(audience)}` }),
        ["mail:read"]
      );
      expect(outcome, audience).toMatchObject({ ok: false, reason: "not_configured", status: 503 });
    }
  });

  it("names a genuinely missing header for what it is", async () => {
    const outcome = await authenticateRestRequest(request(), ["mail:read"]);
    expect(outcome).toMatchObject({ ok: false, reason: "no_credentials" });
    expect(outcome.ok ? "" : outcome.message).toMatch(/missing/i);
  });

  it("distinguishes an unconfigured server from a rejected token", async () => {
    vi.stubEnv("LETTER_IRL_OAUTH_JWKS_URI", "");
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` }),
      ["mail:read"]
    );
    expect(outcome).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("ignores an access_token cookie: a cookie is not a credential (audit A-11)", async () => {
    const outcome = await authenticateRestRequest(
      request({ cookie: `theme=dark; access_token=${await mint(mcpAudience)}` }),
      ["mail:read"]
    );
    expect(outcome).toMatchObject({ ok: false, reason: "no_credentials" });
  });

  it("refuses a valid token without the route's scope with 403 and a challenge naming only what is missing", async () => {
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience, { scope: "mail:read" })}` }),
      ["mail:send"]
    );
    // 403, not 401: signing in again yields the same token.
    expect(outcome).toMatchObject({ ok: false, reason: "insufficient_scope", status: 403 });
    const challenge = outcome.ok ? "" : outcome.challenge ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="mail:send"');
    expect(challenge).not.toContain("mail:read");
  });

  it("admits the same narrow token where its scope is enough", async () => {
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience, { scope: "mail:read" })}` }),
      ["mail:read"]
    );
    expect(outcome).toMatchObject({ ok: true, user: { scopes: ["mail:read"] } });
  });

  it("treats a token with no scope claim as carrying none", async () => {
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience, {})}` }),
      ["mail:read"]
    );
    expect(outcome).toMatchObject({ ok: false, reason: "insufficient_scope" });
  });

  it("checks the scope only once the token itself is valid", async () => {
    // An expired token lacking the scope is a 401 to sign in again, not a 403.
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience, {}, "-5m")}` }),
      ["mail:send"]
    );
    expect(outcome).toMatchObject({ ok: false, reason: "rejected", status: 401 });
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "http";
import { generateKeyPair, SignJWT } from "jose";

/**
 * Issue #209. The REST handlers each carried their own bearer check reading
 * LETTER_IRL_OAUTH_AUDIENCE straight from the environment as a single value,
 * while the MCP layer read the audience through getOAuthConfig() - a list,
 * merged with LETTER_IRL_OAUTH_LEGACY_AUDIENCES under the static-DCR
 * compatibility flag. The website mints tokens for the legacy audience, so
 * every dashboard call was rejected while MCP calls were fine.
 *
 * These tests pin the property that closes it: the REST check accepts exactly
 * the audiences the config layer accepts. They also pin the message, because
 * "Missing or invalid Authorization header" for a present, well-formed,
 * rejected token is what sent the #209 investigation to the wrong service.
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
const legacyAudience = "https://letter-irl/api";

async function mint(audience: string, claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ sub: "auth0|user-1", email: "user@example.invalid", ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
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
    vi.stubEnv("LETTER_IRL_OAUTH_LEGACY_AUDIENCES", legacyAudience);
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "false");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("accepts a token for the MCP audience", async () => {
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` })
    );
    expect(outcome).toEqual({
      ok: true,
      user: { userId: "auth0|user-1", email: "user@example.invalid" }
    });
  });

  it("accepts the legacy audience once compatibility is on - the #209 case", async () => {
    // This is the website's token. Before the fix it was rejected regardless of
    // the flag, because the REST check never consulted the config layer.
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(legacyAudience)}` })
    );
    expect(outcome.ok).toBe(true);
  });

  it("rejects the legacy audience while compatibility is off, and says so", async () => {
    // Same token, flag off: REST and MCP now agree, and both refuse. The point
    // is the message - it must not claim the header was missing.
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(legacyAudience)}` })
    );
    expect(outcome).toMatchObject({ ok: false, reason: "rejected" });
    expect(outcome.ok ? "" : outcome.message).not.toMatch(/missing/i);
  });

  it("names a genuinely missing header for what it is", async () => {
    const outcome = await authenticateRestRequest(request());
    expect(outcome).toMatchObject({ ok: false, reason: "no_credentials" });
    expect(outcome.ok ? "" : outcome.message).toMatch(/missing/i);
  });

  it("distinguishes an unconfigured server from a rejected token", async () => {
    vi.stubEnv("LETTER_IRL_OAUTH_JWKS_URI", "");
    const outcome = await authenticateRestRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` })
    );
    expect(outcome).toMatchObject({ ok: false, reason: "not_configured" });
  });

  it("still honours the access_token cookie the letter handler accepted", async () => {
    const outcome = await authenticateRestRequest(
      request({ cookie: `theme=dark; access_token=${await mint(mcpAudience)}` })
    );
    expect(outcome.ok).toBe(true);
  });
});

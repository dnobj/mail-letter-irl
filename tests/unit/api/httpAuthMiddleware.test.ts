import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { generateKeyPair, SignJWT } from "jose";

/**
 * Issue #209, second instance. authenticateHttpRequest is the auth in front
 * of the Stripe checkout route, and it was the fourth copy of a raw
 * single-value audience check - missed in the first consolidation because it
 * answers "Invalid or expired token" rather than the wording that was searched
 * for. Symptom: the dashboard loads, Buy Now returns 401 three times running.
 *
 * These pin the same property as restAuth.test.ts - the accepted audiences are
 * the config layer's - and additionally pin the response contract, since this
 * middleware writes its own responses and the website's client reads them.
 */

vi.mock("../../../src/services/patService.js", () => ({
  TOKEN_PREFIX: "lirl_pat_",
  validateToken: vi.fn(),
  updateLastUsed: vi.fn().mockResolvedValue(undefined)
}));

let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return { ...actual, createRemoteJWKSet: () => async () => publicKey };
});

import { authenticateHttpRequest } from "../../../src/api/middleware/auth.js";

const issuer = "https://dev-test.auth0.com/";
const mcpAudience = "https://dev-api.example.com/mcp";
const legacyAudience = "https://letter-irl/api";

async function mint(audience: string, expiresIn = "5m"): Promise<string> {
  return new SignJWT({ sub: "auth0|user-1", email: "user@example.invalid" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

function request(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

function response() {
  const state = { statusCode: 0, body: "" };
  const res = {
    set statusCode(v: number) { state.statusCode = v; },
    get statusCode() { return state.statusCode; },
    setHeader: () => undefined,
    end: (body?: string) => { state.body = body ?? ""; }
  } as unknown as http.ServerResponse;
  return { res, state };
}

describe("HTTP auth middleware (checkout route)", () => {
  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("RS256"));
  });

  beforeEach(() => {
    vi.stubEnv("LETTER_IRL_OAUTH_ISSUER", issuer);
    vi.stubEnv("LETTER_IRL_OAUTH_JWKS_URI", `${issuer}.well-known/jwks.json`);
    vi.stubEnv("LETTER_IRL_OAUTH_AUDIENCE", mcpAudience);
    vi.stubEnv("LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS", "RS256");
    vi.stubEnv("LETTER_IRL_OAUTH_LEGACY_AUDIENCES", legacyAudience);
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("accepts the website's legacy-audience token once compatibility is on - the Buy Now case", async () => {
    const { res, state } = response();
    const user = await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(legacyAudience)}` }),
      res
    );
    expect(user).toEqual({ userId: "auth0|user-1", email: "user@example.invalid" });
    expect(state.statusCode).toBe(0); // no error written
  });

  it("rejects the legacy audience while compatibility is off, with the checkout route's own wording", async () => {
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "false");
    const { res, state } = response();
    const user = await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(legacyAudience)}` }),
      res
    );
    expect(user).toBeNull();
    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toEqual({ error: "Invalid or expired token" });
  });

  it("keeps the response contract for a missing token", async () => {
    const { res, state } = response();
    expect(await authenticateHttpRequest(request(), res)).toBeNull();
    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toEqual({ error: "Authentication required" });
  });

  it("keeps the response contract for an expired token", async () => {
    const { res, state } = response();
    expect(await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience, "-5m")}` }),
      res
    )).toBeNull();
    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toEqual({ error: "Token expired" });
  });

  it("answers 503, not 401, when validation is not configured", async () => {
    vi.stubEnv("LETTER_IRL_OAUTH_JWKS_URI", "");
    const { res, state } = response();
    expect(await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` }),
      res
    )).toBeNull();
    expect(state.statusCode).toBe(503);
  });

  it("still reads the access_token cookie", async () => {
    const { res } = response();
    const user = await authenticateHttpRequest(
      request({ cookie: `access_token=${await mint(mcpAudience)}` }),
      res
    );
    expect(user?.userId).toBe("auth0|user-1");
  });
});

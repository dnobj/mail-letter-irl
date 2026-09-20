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
 * These pin the same property as restAuth.test.ts - the accepted audience is
 * the config layer's, now the MCP resource alone - and additionally pin the
 * response contract, since this middleware writes its own responses and the
 * website's client reads them. Audit A-03 added the route's scope, checked
 * with the real requireScopes.
 */

vi.mock("../../../src/services/patService.js", () => ({
  TOKEN_PREFIX: "lirl_pat_",
  validateToken: vi.fn(),
  updateLastUsed: vi.fn().mockResolvedValue(undefined)
}));

// This middleware opens the account row now - the checkout route writes an
// order keyed on users(user_id), so a first-time buyer had none. The two
// functions that would reach PostgreSQL are replaced; the claim reading and
// the refusals run for real.
vi.mock("../../../src/services/userService.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/services/userService.js")>();
  return {
    ...actual,
    findUser: vi.fn(async () => null),
    getOrCreateUser: vi.fn(async (userId: string, email: string) => ({ user_id: userId, email }))
  };
});

let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return { ...actual, createRemoteJWKSet: () => async () => publicKey };
});

import { authenticateHttpRequest } from "../../../src/api/middleware/auth.js";
import {
  VerifiedEmailRequiredError,
  VERIFIED_EMAIL_MESSAGE
} from "../../../src/auth/verifiedEmail.js";
import {
  EmailAlreadyLinkedError,
  EMAIL_ALREADY_LINKED_MESSAGE
} from "../../../src/services/userService.js";

const issuer = "https://dev-test.auth0.com/";
const mcpAudience = "https://dev-api.example.com/mcp";
const retiredAudience = "https://letter-irl/api";
const SEND = ["mail:send"] as const;

async function mint(
  audience: string,
  expiresIn = "5m",
  claims: Record<string, unknown> = { scope: "mail:read mail:draft mail:send" }
): Promise<string> {
  return new SignJWT({
    sub: "auth0|user-1",
    email: "user@example.invalid",
    email_verified: true,
    ...claims
  })
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
  const state = { statusCode: 0, body: "", headers: {} as Record<string, unknown> };
  const res = {
    set statusCode(v: number) { state.statusCode = v; },
    get statusCode() { return state.statusCode; },
    setHeader: (name: string, value: unknown) => { state.headers[name.toLowerCase()] = value; },
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
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("accepts the website's token for the MCP audience - the Buy Now case", async () => {
    const { res, state } = response();
    const user = await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` }),
      res,
      SEND
    );
    expect(user).toEqual({ userId: "auth0|user-1", email: "user@example.invalid" });
    expect(state.statusCode).toBe(0); // no error written
  });

  it("refuses a buyer with no confirmed address, in this route's own shape", async () => {
    // A first-time buyer used to reach the checkout with no users row, and the
    // order's foreign key failed as a database error. 403, because the
    // credentials are fine: authorizing again produces the same token.
    const { getOrCreateUser } = await import("../../../src/services/userService.js");
    vi.mocked(getOrCreateUser).mockRejectedValueOnce(new VerifiedEmailRequiredError());

    const { res, state } = response();
    const user = await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` }),
      res,
      SEND
    );

    expect(user).toBeNull();
    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toEqual({ error: VERIFIED_EMAIL_MESSAGE });
  });

  it("answers 409 when the address belongs to another sign-in method", async () => {
    const { getOrCreateUser } = await import("../../../src/services/userService.js");
    vi.mocked(getOrCreateUser).mockRejectedValueOnce(new EmailAlreadyLinkedError());

    const { res, state } = response();
    const user = await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` }),
      res,
      SEND
    );

    expect(user).toBeNull();
    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toEqual({ error: EMAIL_ALREADY_LINKED_MESSAGE });
  });

  it("rejects the retired website audience, even with the old rollback settings, in the checkout route's own wording", async () => {
    // Before the merge was removed, these two settings made this token valid.
    vi.stubEnv("LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY", "true");
    vi.stubEnv("LETTER_IRL_OAUTH_LEGACY_AUDIENCES", retiredAudience);
    const { res, state } = response();
    const user = await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(retiredAudience)}` }),
      res,
      SEND
    );
    expect(user).toBeNull();
    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toEqual({ error: "Invalid or expired token" });
  });

  it("keeps the response contract for a missing token", async () => {
    const { res, state } = response();
    expect(await authenticateHttpRequest(request(), res, SEND)).toBeNull();
    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toEqual({ error: "Authentication required" });
  });

  it("keeps the response contract for an expired token", async () => {
    const { res, state } = response();
    expect(await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience, "-5m")}` }),
      res,
      SEND
    )).toBeNull();
    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toEqual({ error: "Token expired" });
  });

  it("answers 503, not 401, when validation is not configured", async () => {
    vi.stubEnv("LETTER_IRL_OAUTH_JWKS_URI", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { res, state } = response();
    expect(await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience)}` }),
      res,
      SEND
    )).toBeNull();
    expect(state.statusCode).toBe(503);
    // Logged once, with no fields: the real validator throws before its own log.
    expect(
      error.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('"event":"auth.validation_not_configured"'))
        .map((line) => JSON.parse(line))
    ).toEqual([{ event: "auth.validation_not_configured", msg: "auth.validation_not_configured" }]);
  });

  it("ignores an access_token cookie: a cookie is not a credential (audit A-11)", async () => {
    const { res, state } = response();
    const user = await authenticateHttpRequest(
      request({ cookie: `access_token=${await mint(mcpAudience)}` }),
      res,
      SEND
    );
    expect(user).toBeNull();
    expect(state.statusCode).toBe(401);
  });

  it("refuses a valid token without the route's scope with 403 and a challenge, not a 401", async () => {
    // 401 would say the token is at fault, when the token is valid and simply narrow.
    const { res, state } = response();
    const user = await authenticateHttpRequest(
      request({ authorization: `Bearer ${await mint(mcpAudience, "5m", { scope: "mail:read" })}` }),
      res,
      SEND
    );
    expect(user).toBeNull();
    expect(state.statusCode).toBe(403);
    expect(String(state.headers["www-authenticate"])).toContain('scope="mail:send"');
    expect(JSON.parse(state.body)).toEqual({ error: "The bearer token does not grant this action" });
  });
});

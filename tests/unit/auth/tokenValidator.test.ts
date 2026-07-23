import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT
} from "jose";

vi.mock("../../../src/services/patService.js", () => ({
  TOKEN_PREFIX: "lirl_pat_",
  validateToken: vi.fn(),
  updateLastUsed: vi.fn().mockResolvedValue(undefined)
}));

import {
  requireScopes,
  validateAuthorizationHeader,
  validateJWTToken
} from "../../../src/auth/tokenValidator.js";
import {
  updateLastUsed,
  validateToken
} from "../../../src/services/patService.js";

const issuer = "https://dev-test.auth0.com/";
const audience = "https://dev-api.example.com/mcp";
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let publicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];

async function token(
  claims: Record<string, unknown> = {},
  options: { algorithm?: string; expiresIn?: string; notBefore?: string } = {}
) {
  const algorithm = options.algorithm ?? "RS256";
  let builder = new SignJWT({
    sub: "auth0|user-1",
    scope: "mail:read mail:draft mail:send",
    ...claims
  })
    .setProtectedHeader({ alg: algorithm })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m");
  if (options.notBefore) {
    builder = builder.setNotBefore(options.notBefore);
  }
  return builder.sign(privateKey);
}

describe("production JWT validator", () => {
  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("RS256"));
  });

  beforeEach(() => {
    vi.stubEnv("LETTER_IRL_OAUTH_ISSUER", issuer);
    vi.stubEnv("LETTER_IRL_OAUTH_JWKS_URI", `${issuer}.well-known/jwks.json`);
    vi.stubEnv("LETTER_IRL_OAUTH_AUDIENCE", audience);
    vi.stubEnv("LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS", "RS256");
  });

  afterEach(() => vi.unstubAllEnvs());

  const keySet = async () => publicKey;

  it("accepts a valid Auth0 RS256 token with required scopes", async () => {
    const result = await validateJWTToken(await token(), keySet, ["mail:send"]);
    expect(result).toMatchObject({
      userId: "auth0|user-1",
      authType: "jwt",
      scopes: ["mail:read", "mail:draft", "mail:send"]
    });
  });

  it("rejects a wrong issuer", async () => {
    vi.stubEnv("LETTER_IRL_OAUTH_ISSUER", "https://wrong.auth0.com/");
    await expect(validateJWTToken(await token(), keySet)).rejects.toThrow();
  });

  it("rejects a wrong audience", async () => {
    vi.stubEnv("LETTER_IRL_OAUTH_AUDIENCE", "https://wrong.example/mcp");
    await expect(validateJWTToken(await token(), keySet)).rejects.toThrow();
  });

  it("rejects expired and not-yet-valid tokens", async () => {
    await expect(
      validateJWTToken(await token({}, { expiresIn: "-1s" }), keySet)
    ).rejects.toThrow();
    await expect(
      validateJWTToken(await token({}, { notBefore: "5m" }), keySet)
    ).rejects.toThrow();
  });

  it("rejects a missing scope and malformed subject", async () => {
    await expect(
      validateJWTToken(await token({ scope: "mail:read" }), keySet, ["mail:send"])
    ).rejects.toThrow("insufficient_scope");
    await expect(
      validateJWTToken(await token({ sub: " " }), keySet)
    ).rejects.toThrow("valid subject");
  });

  it("rejects none and unexpected signing algorithms", async () => {
    const noneToken = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: audience,
        sub: "auth0|user",
        exp: Math.floor(Date.now() / 1000) + 300
      })
    ).toString("base64url")}.`;
    await expect(validateJWTToken(noneToken, keySet)).rejects.toThrow();

    const esKeys = await generateKeyPair("ES256");
    const esToken = await new SignJWT({ sub: "auth0|user" })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(esKeys.privateKey);
    await expect(validateJWTToken(esToken, async () => esKeys.publicKey)).rejects.toThrow();
  });

  it("verifies the token cryptographically rather than trusting decoded claims", async () => {
    const jwk = await exportJWK(publicKey);
    const imported = await importJWK(jwk, "RS256");
    const signed = await token();
    await expect(
      jwtVerify(signed, imported, {
        issuer,
        audience,
        algorithms: ["RS256"]
      })
    ).resolves.toBeDefined();
  });
});

describe("PAT separation", () => {
  afterEach(() => vi.clearAllMocks());

  it("routes PATs to the PAT validator and treats tool scopes separately", async () => {
    vi.mocked(validateToken).mockResolvedValue({
      valid: true,
      userId: "pat-user",
      tokenId: "token-1"
    });
    const result = await validateAuthorizationHeader("Bearer lirl_pat_secret");
    expect(result.authType).toBe("pat");
    expect(result.scopes).toEqual([]);
    expect(() => requireScopes(result, ["mail:send"])).not.toThrow();
    expect(updateLastUsed).toHaveBeenCalledWith("token-1");
  });

  it("rejects malformed authorization headers without leaking the credential", async () => {
    await expect(validateAuthorizationHeader("Basic secret")).rejects.toThrow(
      "Bearer token"
    );
  });
});

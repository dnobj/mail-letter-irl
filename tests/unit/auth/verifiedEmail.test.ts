import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_CLAIM,
  DEFAULT_EMAIL_VERIFIED_CLAIM,
  readEmailClaim,
  readUserInfoEmail
} from "../../../src/auth/verifiedEmail.js";

/**
 * The truth table for "may an account be opened from this?".
 *
 * One rule: the issuer has to SAY the address is confirmed. Silence is not
 * confirmation, and the case below that pins it - an address claim with no
 * verdict beside it - is exactly what the Action deployed until 2026-09-19
 * emitted for an unconfirmed address.
 */

const NONE = {} as NodeJS.ProcessEnv;

describe("reading an address off a token", () => {
  it("takes the standard claim first, and confirms it when the issuer does", () => {
    expect(
      readEmailClaim({ email: "person@example.com", email_verified: true }, NONE)
    ).toEqual({ address: "person@example.com", verified: true });
  });

  it("does not confirm a standard claim the issuer says nothing about", () => {
    expect(readEmailClaim({ email: "person@example.com" }, NONE)).toEqual({
      address: "person@example.com",
      verified: false
    });
    expect(
      readEmailClaim({ email: "person@example.com", email_verified: false }, NONE)?.verified
    ).toBe(false);
  });

  it("takes the namespaced claim when the standard one is absent", () => {
    expect(
      readEmailClaim(
        {
          [DEFAULT_EMAIL_CLAIM]: "person@example.com",
          [DEFAULT_EMAIL_VERIFIED_CLAIM]: true
        },
        NONE
      )
    ).toEqual({ address: "person@example.com", verified: true });
  });

  it("does not confirm a namespaced address with no verdict beside it", () => {
    // THE case. The Action deployed on both tenants until 2026-09-19 set the
    // address claim for any address, confirmed or not. Reading that silence as
    // confirmation would let an unconfirmed sign-up take the account slot of
    // whoever actually owns the address.
    expect(readEmailClaim({ [DEFAULT_EMAIL_CLAIM]: "person@example.com" }, NONE)).toEqual({
      address: "person@example.com",
      verified: false
    });
  });

  it("reads a verdict that arrived as a string, and confirms on nothing else", () => {
    const claims = (value: unknown) => ({
      [DEFAULT_EMAIL_CLAIM]: "person@example.com",
      [DEFAULT_EMAIL_VERIFIED_CLAIM]: value
    });
    expect(readEmailClaim(claims("true"), NONE)?.verified).toBe(true);
    for (const almost of ["false", "yes", "1", 1, 0, null, undefined, {}]) {
      expect(readEmailClaim(claims(almost), NONE)?.verified, String(almost)).toBe(false);
    }
  });

  it("honours a configured namespace for both claims", () => {
    // The namespace is a deployment's own domain and the two environments do
    // not share one. A verdict left under the default key while the address
    // moved would be silently ignored, so both are configurable together.
    const env = {
      LETTER_IRL_OAUTH_EMAIL_CLAIM: "https://dev.example/email",
      LETTER_IRL_OAUTH_EMAIL_VERIFIED_CLAIM: "https://dev.example/email_verified"
    } as NodeJS.ProcessEnv;

    expect(
      readEmailClaim(
        {
          "https://dev.example/email": "person@example.com",
          "https://dev.example/email_verified": true
        },
        env
      )
    ).toEqual({ address: "person@example.com", verified: true });
    // A verdict left under the DEFAULT key while the address moved is not a
    // verdict about this address.
    expect(
      readEmailClaim(
        {
          "https://dev.example/email": "person@example.com",
          [DEFAULT_EMAIL_VERIFIED_CLAIM]: true
        },
        env
      )?.verified
    ).toBe(false);
  });

  it("finds nothing in a token that carries nothing, or only blank space", () => {
    expect(readEmailClaim({}, NONE)).toBeNull();
    expect(readEmailClaim({ email: "   " }, NONE)).toBeNull();
    expect(readEmailClaim({ email: 42 }, NONE)).toBeNull();
  });

  it("trims what it does find, so no address is stored with an edge of space", () => {
    expect(
      readEmailClaim({ email: "  person@example.com  ", email_verified: true }, NONE)?.address
    ).toBe("person@example.com");
  });
});

describe("reading a userinfo document", () => {
  it("reads both standard fields", () => {
    expect(readUserInfoEmail({ email: "person@example.com", email_verified: true })).toEqual({
      address: "person@example.com",
      verified: true
    });
    expect(readUserInfoEmail({ email: "person@example.com", email_verified: false })).toEqual({
      address: "person@example.com",
      verified: false
    });
    expect(readUserInfoEmail({ email: "person@example.com" })?.verified).toBe(false);
  });

  it("survives a document that is not one", () => {
    expect(readUserInfoEmail(null)).toBeNull();
    expect(readUserInfoEmail("not json")).toBeNull();
    expect(readUserInfoEmail({})).toBeNull();
  });
});

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
 * Three values, not two. The issuer confirms, refuses, or says nothing - and
 * the case that pins the difference, an address claim with no verdict beside
 * it, is exactly what the Action deployed until 2026-09-19 emitted for every
 * address, confirmed or not. Collapsing it into a refusal locks out the
 * confirmed ones; collapsing it into a confirmation lets the unconfirmed take
 * someone else's account. identity.ts asks the issuer instead.
 */

const NONE = {} as NodeJS.ProcessEnv;

describe("reading an address off a token", () => {
  it("takes the standard claim first, and confirms it when the issuer does", () => {
    expect(
      readEmailClaim({ email: "person@example.com", email_verified: true }, NONE)
    ).toEqual({ address: "person@example.com", verdict: true });
  });

  it("separates a refusal from silence on the standard claim", () => {
    expect(readEmailClaim({ email: "person@example.com" }, NONE)).toEqual({
      address: "person@example.com",
      verdict: null
    });
    expect(
      readEmailClaim({ email: "person@example.com", email_verified: false }, NONE)?.verdict
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
    ).toEqual({ address: "person@example.com", verdict: true });
  });

  it("returns no verdict for a namespaced address that arrives without one", () => {
    // THE case. The Action deployed on both tenants until 2026-09-19 set the
    // address claim for any address, confirmed or not - so this shape says
    // nothing either way, and neither may be assumed from it.
    expect(readEmailClaim({ [DEFAULT_EMAIL_CLAIM]: "person@example.com" }, NONE)).toEqual({
      address: "person@example.com",
      verdict: null
    });
  });

  it("reads a verdict that arrived as a string, and calls the rest silence", () => {
    const claims = (value: unknown) => ({
      [DEFAULT_EMAIL_CLAIM]: "person@example.com",
      [DEFAULT_EMAIL_VERIFIED_CLAIM]: value
    });
    expect(readEmailClaim(claims("true"), NONE)?.verdict).toBe(true);
    expect(readEmailClaim(claims("false"), NONE)?.verdict).toBe(false);
    expect(readEmailClaim(claims(false), NONE)?.verdict).toBe(false);
    for (const neither of ["yes", "1", 1, 0, null, undefined, {}]) {
      expect(readEmailClaim(claims(neither), NONE)?.verdict, String(neither)).toBeNull();
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
    ).toEqual({ address: "person@example.com", verdict: true });
    // A verdict left under the DEFAULT key while the address moved is not a
    // verdict about this address.
    expect(
      readEmailClaim(
        {
          "https://dev.example/email": "person@example.com",
          [DEFAULT_EMAIL_VERIFIED_CLAIM]: true
        },
        env
      )?.verdict
    ).toBeNull();
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
      verdict: true
    });
    expect(readUserInfoEmail({ email: "person@example.com", email_verified: false })).toEqual({
      address: "person@example.com",
      verdict: false
    });
    // The issuer asked directly and said nothing: still not a confirmation,
    // and identity.ts has nowhere further to go.
    expect(readUserInfoEmail({ email: "person@example.com" })?.verdict).toBeNull();
  });

  it("survives a document that is not one", () => {
    expect(readUserInfoEmail(null)).toBeNull();
    expect(readUserInfoEmail("not json")).toBeNull();
    expect(readUserInfoEmail({})).toBeNull();
  });
});

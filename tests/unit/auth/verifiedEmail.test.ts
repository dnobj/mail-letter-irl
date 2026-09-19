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
 * The rule is asymmetric and that asymmetry is the decision worth pinning: an
 * issuer saying `email_verified: false` refuses, an issuer saying nothing does
 * not. The reasoning is in the module; these are the cases it has to produce.
 */

const NONE = {} as NodeJS.ProcessEnv;

describe("reading an address off a token", () => {
  it("takes the standard claim first, and confirms it", () => {
    expect(readEmailClaim({ email: "person@example.com" }, NONE)).toEqual({
      address: "person@example.com",
      verified: true
    });
  });

  it("refuses a standard claim the issuer marks unconfirmed", () => {
    expect(
      readEmailClaim({ email: "person@example.com", email_verified: false }, NONE)
    ).toEqual({ address: "person@example.com", verified: false });
  });

  it("takes the namespaced claim when the standard one is absent", () => {
    expect(readEmailClaim({ [DEFAULT_EMAIL_CLAIM]: "person@example.com" }, NONE)).toEqual({
      address: "person@example.com",
      verified: true
    });
  });

  it("believes a namespaced verdict of false over the Action's contract", () => {
    expect(
      readEmailClaim(
        {
          [DEFAULT_EMAIL_CLAIM]: "person@example.com",
          [DEFAULT_EMAIL_VERIFIED_CLAIM]: false
        },
        NONE
      )
    ).toEqual({ address: "person@example.com", verified: false });
  });

  it("reads a verdict that arrived as a string, and ignores one that is neither", () => {
    // A custom claim set from a string, or a document proxied through
    // something helpful, arrives as "false". Anything else - 0, "no", null -
    // is not a verdict, and silence is not a refusal.
    const claims = (value: unknown) => ({
      [DEFAULT_EMAIL_CLAIM]: "person@example.com",
      [DEFAULT_EMAIL_VERIFIED_CLAIM]: value
    });
    expect(readEmailClaim(claims("false"), NONE)?.verified).toBe(false);
    expect(readEmailClaim(claims("true"), NONE)?.verified).toBe(true);
    expect(readEmailClaim(claims(0), NONE)?.verified).toBe(true);
    expect(readEmailClaim(claims(null), NONE)?.verified).toBe(true);
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
          "https://dev.example/email_verified": false
        },
        env
      )
    ).toEqual({ address: "person@example.com", verified: false });
  });

  it("finds nothing in a token that carries nothing, or only blank space", () => {
    expect(readEmailClaim({}, NONE)).toBeNull();
    expect(readEmailClaim({ email: "   " }, NONE)).toBeNull();
    expect(readEmailClaim({ email: 42 }, NONE)).toBeNull();
  });

  it("trims what it does find, so no address is stored with an edge of space", () => {
    expect(readEmailClaim({ email: "  person@example.com  " }, NONE)?.address).toBe(
      "person@example.com"
    );
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
  });

  it("survives a document that is not one", () => {
    expect(readUserInfoEmail(null)).toBeNull();
    expect(readUserInfoEmail("not json")).toBeNull();
    expect(readUserInfoEmail({})).toBeNull();
  });
});

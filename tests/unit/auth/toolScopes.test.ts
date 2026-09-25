import { describe, expect, it } from "vitest";
import {
  authorizeTool,
  getRequiredToolScopes
} from "../../../src/auth/toolScopes.js";
import { AuthenticatedUser } from "../../../src/auth/tokenValidator.js";

function jwt(scopes: string[]): AuthenticatedUser {
  return {
    userId: "auth0|user",
    claims: {},
    token: "redacted",
    authType: "jwt",
    scopes
  };
}

describe("tool scope enforcement", () => {
  it.each([
    ["get_account_balance", "mail:read"],
    ["get_purchase_status", "mail:read"],
    ["generate_image_for_mail", "mail:draft"],
    ["create_mail_checkout", "mail:send"],
    ["send_letter", "mail:send"]
  ])("maps %s to %s in metadata and runtime", (toolName, scope) => {
    expect(getRequiredToolScopes(toolName)).toEqual([scope]);
    expect(() => authorizeTool(toolName, jwt([scope]), true)).not.toThrow();
    expect(() => authorizeTool(toolName, jwt([]), true)).toThrow(
      "insufficient_scope"
    );
  });

  it("fails closed for an unmapped tool", () => {
    expect(() => getRequiredToolScopes("new_unmapped_tool")).toThrow(
      "No OAuth scope mapping"
    );
  });

  it("checks a personal access token's own scopes like any other token's (#470)", () => {
    // Read and draft, what migration 037 gives every token. It used to pass
    // every check here, send included.
    const pat: AuthenticatedUser = {
      userId: "pat-user",
      claims: { authType: "pat" },
      token: "redacted",
      authType: "pat",
      scopes: ["mail:read", "mail:draft"]
    };
    expect(() => authorizeTool("get_account_balance", pat, true)).not.toThrow();
    expect(() => authorizeTool("quote_and_preview_letter", pat, true)).not.toThrow();
    expect(() => authorizeTool("send_letter", pat, true)).toThrow("insufficient_scope");
    expect(() => authorizeTool("create_mail_checkout", pat, true)).toThrow("insufficient_scope");
    expect(() => authorizeTool("get_account_balance", { ...pat, scopes: [] }, true)).toThrow(
      "insufficient_scope"
    );
  });
});

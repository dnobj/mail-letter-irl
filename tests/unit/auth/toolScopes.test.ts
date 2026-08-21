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
    ["generate_image_fallback", "mail:draft"],
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

  it("keeps PAT authorization on its separate server-side path", () => {
    const pat: AuthenticatedUser = {
      userId: "pat-user",
      claims: { authType: "pat" },
      token: "redacted",
      authType: "pat",
      scopes: []
    };
    expect(() => authorizeTool("send_letter", pat, true)).not.toThrow();
  });
});

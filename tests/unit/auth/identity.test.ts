import { describe, expect, it, vi } from "vitest";
import { prepareAuthenticatedUser } from "../../../src/auth/identity.js";
import { AuthenticatedUser } from "../../../src/auth/tokenValidator.js";

function user(authType: "jwt" | "pat"): AuthenticatedUser {
  return {
    userId: "user-1",
    claims: {},
    token: "secret-token",
    authType,
    scopes: []
  };
}

describe("authenticated identity handling", () => {
  it("never calls Auth0 userinfo for a PAT", async () => {
    const fetchUserInfo = vi.fn();
    await prepareAuthenticatedUser(user("pat"), {
      fetchUserInfo,
      findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
      upsertUser: vi.fn()
    });
    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  it("does not overwrite a known email when userinfo is unavailable", async () => {
    const upsertUser = vi.fn();
    await prepareAuthenticatedUser(user("jwt"), {
      fetchUserInfo: vi.fn().mockRejectedValue(new Error("timeout")),
      findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
      upsertUser
    });
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("uses a verified JWT email without a userinfo request", async () => {
    const fetchUserInfo = vi.fn();
    const upsertUser = vi.fn();
    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { email: "verified@example.com" } },
      {
        fetchUserInfo,
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser
      }
    );
    expect(fetchUserInfo).not.toHaveBeenCalled();
    expect(upsertUser).toHaveBeenCalledWith("user-1", "verified@example.com");
  });
});

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

describe("an account that cannot be created", () => {
  // The state this leaves behind is not "deferred" - nothing retries it, and
  // users.email is NOT NULL so there is no row to create without an address.
  // The account does not exist, and the customer discovers that later, in
  // whichever subsystem writes first. Production found it three ways at once
  // and none of them said so.
  it("reports the missing account at error level, naming the consequence", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(value => {
      logged.push(String(value));
    });

    await prepareAuthenticatedUser(user("jwt"), {
      fetchUserInfo: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
      findExistingUser: vi.fn().mockResolvedValue(null),
      upsertUser: vi.fn()
    });

    spy.mockRestore();

    const payloads = logged.map(line => JSON.parse(line) as Record<string, unknown>);
    const account = payloads.find(
      entry => entry.event === "auth.account_missing_no_verified_email"
    );
    expect(account, "no account-missing diagnostic was emitted").toBeDefined();
    expect(account?.consequence).toBe("account_writes_will_fail");
    // Warn was the old level, and a warning is what let this sit unnoticed.
    expect(account?.msg).toBe("auth.account_missing_no_verified_email");
  });

  it("says nothing when the account already exists", async () => {
    // Guards the assertion above: an existing user with no email available is
    // an ordinary state, not a fault, and must not page anyone.
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(value => {
      logged.push(String(value));
    });

    await prepareAuthenticatedUser(user("jwt"), {
      fetchUserInfo: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
      findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
      upsertUser: vi.fn()
    });

    spy.mockRestore();
    expect(
      logged.filter(line => line.includes("auth.account_missing_no_verified_email"))
    ).toEqual([]);
  });
});

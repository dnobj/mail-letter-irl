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

describe("the namespaced email claim", () => {
  // Auth0 drops a non-namespaced custom claim that collides with a reserved
  // OIDC name, and `email` is reserved. An Action calling
  // setCustomClaim("email", ...) therefore does nothing at all - the login
  // succeeds, the claim is absent, and no error is raised anywhere. That is
  // not a hypothetical: it was deployed against production, looked like a
  // fix, and the next tool call failed the same foreign key as before.
  const NS = "https://letterirl.com/email";

  it("provisions from the namespaced claim without calling userinfo", async () => {
    const fetchUserInfo = vi.fn();
    const upsertUser = vi.fn();

    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { [NS]: "namespaced@example.com" } },
      { fetchUserInfo, findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
      {} as NodeJS.ProcessEnv
    );

    expect(upsertUser).toHaveBeenCalledWith("user-1", "namespaced@example.com");
    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  it("prefers the standard claim when both are present", async () => {
    // If Auth0 ever puts `email` on the access token natively, believe that
    // one - it needs no Action and cannot drift out of sync with one.
    const upsertUser = vi.fn();

    await prepareAuthenticatedUser(
      {
        ...user("jwt"),
        claims: { email: "standard@example.com", [NS]: "namespaced@example.com" }
      },
      { fetchUserInfo: vi.fn(), findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
      {} as NodeJS.ProcessEnv
    );

    expect(upsertUser).toHaveBeenCalledWith("user-1", "standard@example.com");
  });

  it("honours a configured namespace", async () => {
    // The namespace is a deployment's own domain; the two environments do not
    // share one, so this must not be hardcoded.
    const upsertUser = vi.fn();

    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { "https://dev.example/email": "dev@example.com" } },
      { fetchUserInfo: vi.fn(), findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
      { LETTER_IRL_OAUTH_EMAIL_CLAIM: "https://dev.example/email" } as NodeJS.ProcessEnv
    );

    expect(upsertUser).toHaveBeenCalledWith("user-1", "dev@example.com");
  });

  it("ignores a non-namespaced claim under the configured key", async () => {
    // Guards against the fix being satisfied by reading any old `email`
    // property: the whole point is that the bare name never arrives.
    const upsertUser = vi.fn();

    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { "not-the-claim": "wrong@example.com" } },
      {
        fetchUserInfo: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser
      },
      {} as NodeJS.ProcessEnv
    );

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("still falls back to userinfo when no claim carries an email", async () => {
    const upsertUser = vi.fn();

    await prepareAuthenticatedUser(
      user("jwt"),
      {
        fetchUserInfo: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ email: "fallback@example.com" })
        }),
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser
      },
      { LETTER_IRL_OAUTH_ISSUER: "https://tenant.example.com/" } as NodeJS.ProcessEnv
    );

    expect(upsertUser).toHaveBeenCalledWith("user-1", "fallback@example.com");
  });
});

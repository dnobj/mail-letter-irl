import { describe, expect, it, vi } from "vitest";
import { prepareAuthenticatedUser } from "../../../src/auth/identity.js";
import { VerifiedEmailRequiredError } from "../../../src/auth/verifiedEmail.js";
import { EmailAlreadyLinkedError } from "../../../src/services/userService.js";
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

/**
 * A token shaped like the website's, which asks for `openid`. It is the only
 * shape Auth0's /userinfo will answer for: ChatGPT asks for the product scopes
 * plus offline_access and nothing else, so its tokens - the ones in `user()`
 * above - are refused there.
 */
function websiteUser(): AuthenticatedUser {
  return { ...user("jwt"), scopes: ["openid", "profile", "email", "mail:read"] };
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
      { ...user("jwt"), claims: { email: "verified@example.com", email_verified: true } },
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
  it("refuses, and reports it at error level naming the consequence", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(value => {
      logged.push(String(value));
    });

    await expect(
      prepareAuthenticatedUser(user("jwt"), {
        fetchUserInfo: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser: vi.fn()
      })
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    spy.mockRestore();

    const payloads = logged.map(line => JSON.parse(line) as Record<string, unknown>);
    const account = payloads.find(
      entry => entry.event === "auth.account_missing_no_verified_email"
    );
    expect(account, "no account-missing diagnostic was emitted").toBeDefined();
    expect(account?.consequence).toBe("account_not_opened");
    // Warn was the old level, and a warning is what let this sit unnoticed.
    expect(account?.msg).toBe("auth.account_missing_no_verified_email");
  });

  it("says nothing about the account it could not open beyond a fixed sentence", async () => {
    // The message reaches a customer through a tool result and an HTTP body,
    // so nothing from the request may be interpolated into it.
    const refusal = await prepareAuthenticatedUser(
      { ...user("jwt"), userId: "auth0|secret-subject" },
      {
        fetchUserInfo: vi.fn(),
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser: vi.fn()
      },
      {} as NodeJS.ProcessEnv
    ).catch((error: Error) => error);

    expect((refusal as Error).message).not.toContain("secret-subject");
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
  const NS_VERIFIED = "https://letterirl.com/email_verified";

  it("provisions from the namespaced claim without calling userinfo", async () => {
    const fetchUserInfo = vi.fn();
    const upsertUser = vi.fn();

    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { [NS]: "namespaced@example.com", [NS_VERIFIED]: true } },
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
        claims: {
          email: "standard@example.com",
          email_verified: true,
          [NS]: "namespaced@example.com",
          [NS_VERIFIED]: true
        }
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
      {
        ...user("jwt"),
        claims: {
          "https://dev.example/email": "dev@example.com",
          "https://dev.example/email_verified": true
        }
      },
      { fetchUserInfo: vi.fn(), findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
      {
        LETTER_IRL_OAUTH_EMAIL_CLAIM: "https://dev.example/email",
        LETTER_IRL_OAUTH_EMAIL_VERIFIED_CLAIM: "https://dev.example/email_verified"
      } as NodeJS.ProcessEnv
    );

    expect(upsertUser).toHaveBeenCalledWith("user-1", "dev@example.com");
  });

  it("ignores a non-namespaced claim under the configured key", async () => {
    // Guards against the fix being satisfied by reading any old `email`
    // property: the whole point is that the bare name never arrives.
    const upsertUser = vi.fn();

    await expect(
      prepareAuthenticatedUser(
        { ...user("jwt"), claims: { "not-the-claim": "wrong@example.com" } },
        {
          fetchUserInfo: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser
        },
        {} as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("still falls back to userinfo when no claim carries an email", async () => {
    const upsertUser = vi.fn();

    await prepareAuthenticatedUser(
      websiteUser(),
      {
        fetchUserInfo: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ email: "fallback@example.com", email_verified: true })
        }),
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser
      },
      { LETTER_IRL_OAUTH_ISSUER: "https://tenant.example.com/" } as NodeJS.ProcessEnv
    );

    expect(upsertUser).toHaveBeenCalledWith("user-1", "fallback@example.com");
  });
});

describe("an address the issuer will not vouch for", () => {
  // The rule is asymmetric on purpose (src/auth/verifiedEmail.ts): an explicit
  // `email_verified: false` refuses, silence does not. The gate that stops an
  // unconfirmed address before a subject exists is the Auth0 Action; this is
  // what the server does with what reaches it.
  const NS = "https://letterirl.com/email";
  const NS_VERIFIED = "https://letterirl.com/email_verified";

  it("opens no account from an address the Action marks unconfirmed", async () => {
    const upsertUser = vi.fn();

    await expect(
      prepareAuthenticatedUser(
        {
          ...user("jwt"),
          claims: { [NS]: "unconfirmed@example.com", [NS_VERIFIED]: false }
        },
        { fetchUserInfo: vi.fn(), findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
        {} as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("opens no account from a userinfo document that says the same", async () => {
    const upsertUser = vi.fn();

    await expect(
      prepareAuthenticatedUser(
        user("jwt"),
        {
          fetchUserInfo: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ email: "unconfirmed@example.com", email_verified: false })
          }),
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser
        },
        { LETTER_IRL_OAUTH_ISSUER: "https://tenant.example.com/" } as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("leaves an existing account alone rather than re-pointing it at one", async () => {
    // Someone who already has an account keeps it. Their stored address was
    // confirmed when it was written, and an unconfirmed one arriving later -
    // which is how an address someone else owns would arrive - must not
    // replace it, nor lock them out of an account that already works.
    const upsertUser = vi.fn();

    const email = await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { [NS]: "unconfirmed@example.com", [NS_VERIFIED]: false } },
      {
        fetchUserInfo: vi.fn(),
        findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
        upsertUser
      },
      {} as NodeJS.ProcessEnv
    );

    expect(upsertUser).not.toHaveBeenCalled();
    expect(email).toBe("known@example.com");
  });

  it("asks the issuer when the token carries an address but no verdict", async () => {
    // The rollout window. A token minted before the tenant's Action was
    // updated carries the address and says nothing about it, and those tokens
    // live 24 hours. Treating that as a refusal told customers whose address
    // was confirmed long ago to go and confirm it.
    const upsertUser = vi.fn();
    const fetchUserInfo = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ email: "confirmed@example.com", email_verified: true })
    });

    const email = await prepareAuthenticatedUser(
      { ...websiteUser(), claims: { [NS]: "confirmed@example.com" } },
      { fetchUserInfo, findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
      { LETTER_IRL_OAUTH_ISSUER: "https://tenant.example.com/" } as NodeJS.ProcessEnv
    );

    expect(fetchUserInfo).toHaveBeenCalledOnce();
    expect(upsertUser).toHaveBeenCalledWith("user-1", "confirmed@example.com");
    expect(email).toBe("confirmed@example.com");
  });

  it("refuses when the issuer, asked directly, says the address is not confirmed", async () => {
    const upsertUser = vi.fn();

    await expect(
      prepareAuthenticatedUser(
        { ...websiteUser(), claims: { [NS]: "unconfirmed@example.com" } },
        {
          fetchUserInfo: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ email: "unconfirmed@example.com", email_verified: false })
          }),
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser
        },
        { LETTER_IRL_OAUTH_ISSUER: "https://tenant.example.com/" } as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("asks nobody for a ChatGPT token, which Auth0 would refuse anyway", async () => {
    // ChatGPT asks for the product scopes plus offline_access - the union of
    // the per-tool securitySchemes - so its tokens carry no `openid` and
    // /userinfo answers them 401. Making the call anyway would put a
    // guaranteed failure, with a five-second ceiling, in front of every first
    // arrival. So this shape is refused without one, and the diagnostic says
    // which of the two states it is.
    const fetchUserInfo = vi.fn();
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(value => {
      logged.push(String(value));
    });

    await expect(
      prepareAuthenticatedUser(
        { ...user("jwt"), claims: { [NS]: "confirmed@example.com" } },
        {
          fetchUserInfo,
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser: vi.fn()
        },
        { LETTER_IRL_OAUTH_ISSUER: "https://tenant.example.com/" } as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    spy.mockRestore();
    expect(fetchUserInfo).not.toHaveBeenCalled();
    const refusal = logged
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(entry => entry.event === "auth.account_missing_no_verified_email");
    expect(refusal?.userInfo).toBe("not_asked_no_openid");
    expect(refusal?.reason).toBe("email_verdict_unavailable");
  });

  it("asks nobody when the token's own verdict is a refusal", async () => {
    // An issuer that has already said "not confirmed" has nothing to add, and
    // the network call is on the authentication path.
    const fetchUserInfo = vi.fn();

    await expect(
      prepareAuthenticatedUser(
        { ...websiteUser(), claims: { [NS]: "unconfirmed@example.com", [NS_VERIFIED]: false } },
        {
          fetchUserInfo,
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser: vi.fn()
        },
        { LETTER_IRL_OAUTH_ISSUER: "https://tenant.example.com/" } as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  it("keeps an existing account whose confirmed address another subject holds", async () => {
    // The linking Action has not joined these two identities yet - or there is
    // a leftover row on that address from before this change. Either way the
    // person in front of us HAS an account, with credits and letters in it.
    // Refusing would lock them out of it over a conflict they cannot see.
    const upsertUser = vi.fn().mockRejectedValue(new EmailAlreadyLinkedError());

    const email = await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { [NS]: "shared@example.com", [NS_VERIFIED]: true } },
      {
        fetchUserInfo: vi.fn(),
        findExistingUser: vi.fn().mockResolvedValue({ email: "mine@example.com" }),
        upsertUser
      },
      {} as NodeJS.ProcessEnv
    );

    expect(email).toBe("mine@example.com");
  });

  it("refuses a caller with no account when the address is another subject's", async () => {
    // Same collision, no account of their own: this one IS the refusal, and it
    // is 409 rather than 403 because only an operator can join the two.
    await expect(
      prepareAuthenticatedUser(
        { ...user("jwt"), claims: { [NS]: "shared@example.com", [NS_VERIFIED]: true } },
        {
          fetchUserInfo: vi.fn(),
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser: vi.fn().mockRejectedValue(new EmailAlreadyLinkedError())
        },
        {} as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(EmailAlreadyLinkedError);
  });

  it("asks Auth0 nothing when the account already exists", async () => {
    // /userinfo is rate-limited per user (burst 10, 5 a minute) and sits in
    // front of every REST request. An existing account needs nothing from it.
    const fetchUserInfo = vi.fn();

    const email = await prepareAuthenticatedUser(
      user("jwt"),
      {
        fetchUserInfo,
        findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
        upsertUser: vi.fn()
      },
      { LETTER_IRL_OAUTH_ISSUER: "https://tenant.example.com/" } as NodeJS.ProcessEnv
    );

    expect(email).toBe("known@example.com");
    expect(fetchUserInfo).not.toHaveBeenCalled();
  });

  it("says nothing about an existing account whose token simply carries no verdict", async () => {
    // The rollout window again, from the other side: every existing customer
    // presents a verdict-less token until theirs expires. Warning once per
    // request that their address is unconfirmed - when the issuer had merely
    // not said - is how an operator ends up chasing the wrong fault.
    const logged: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation(value => {
      logged.push(String(value));
    });

    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { [NS]: "known@example.com" } },
      {
        fetchUserInfo: vi.fn(),
        findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
        upsertUser: vi.fn()
      },
      {} as NodeJS.ProcessEnv
    );

    spy.mockRestore();
    expect(logged.filter(line => line.includes("auth.email_unconfirmed_not_stored"))).toEqual([]);
  });

  it("does say so when the issuer states the address is unconfirmed", async () => {
    // Guards the assertion above: the warn must not have been dropped.
    const logged: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation(value => {
      logged.push(String(value));
    });

    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { [NS]: "other@example.com", [NS_VERIFIED]: false } },
      {
        fetchUserInfo: vi.fn(),
        findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
        upsertUser: vi.fn()
      },
      {} as NodeJS.ProcessEnv
    );

    spy.mockRestore();
    expect(logged.some(line => line.includes("auth.email_unconfirmed_not_stored"))).toBe(true);
  });

  it("hands the confirmed address back to its caller", async () => {
    // The REST middleware used to read the standard `email` claim alone, which
    // Auth0 does not put on an access token minted for a custom API, so every
    // route saw `email: undefined`. It takes this return value now.
    const email = await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { [NS]: "confirmed@example.com", [NS_VERIFIED]: true } },
      {
        fetchUserInfo: vi.fn(),
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser: vi.fn()
      },
      {} as NodeJS.ProcessEnv
    );

    expect(email).toBe("confirmed@example.com");
  });
});

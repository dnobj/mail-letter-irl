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


describe("authenticated identity handling", () => {
  it("keeps a personal access token working, which carries no claims at all", async () => {
    // A PAT's claims are {authType, tokenId}: no address, ever. It belongs to
    // an account somebody already opened, and must never be refused for
    // presenting what it always presents.
    const upsertUser = vi.fn();

    const email = await prepareAuthenticatedUser(user("pat"), {
      findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
      upsertUser
    });

    expect(email).toBe("known@example.com");
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("does not overwrite a known email when the token carries none", async () => {
    const upsertUser = vi.fn();
    await prepareAuthenticatedUser(user("jwt"), {
      findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
      upsertUser
    });
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("uses a confirmed standard claim", async () => {
    const upsertUser = vi.fn();
    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { email: "verified@example.com", email_verified: true } },
      {
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser
      }
    );
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

  it("names which of the three faults it is", async () => {
    // The customer sees one sentence either way; the operator needs three
    // answers. An address the customer has not confirmed is their problem. An
    // address with no verdict beside it, or no address at all, is the
    // tenant's - the claim Action is not setting the verdict, or is not
    // running - and nobody can tell those apart from the sentence.
    const NAMESPACE = "https://letterirl.com/email";
    const VERDICT = "https://letterirl.com/email_verified";

    async function reasonFor(claims: Record<string, unknown>): Promise<unknown> {
      const logged: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation(value => {
        logged.push(String(value));
      });
      await prepareAuthenticatedUser(
        { ...user("jwt"), claims },
        {
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser: vi.fn()
        },
        {} as NodeJS.ProcessEnv
      ).catch(() => undefined);
      spy.mockRestore();
      return logged
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .find(entry => entry.event === "auth.account_missing_no_verified_email")?.reason;
    }

    expect(await reasonFor({ [NAMESPACE]: "x@example.com", [VERDICT]: false })).toBe(
      "email_unconfirmed"
    );
    expect(await reasonFor({ [NAMESPACE]: "x@example.com" })).toBe("email_verdict_unavailable");
    expect(await reasonFor({})).toBe("verified_email_unavailable");
  });

  it("says nothing about the account it could not open beyond a fixed sentence", async () => {
    // The message reaches a customer through a tool result and an HTTP body,
    // so nothing from the request may be interpolated into it.
    const refusal = await prepareAuthenticatedUser(
      { ...user("jwt"), userId: "auth0|secret-subject" },
      {
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

  it("provisions from the namespaced claim and its verdict", async () => {
    const upsertUser = vi.fn();

    await prepareAuthenticatedUser(
      { ...user("jwt"), claims: { [NS]: "namespaced@example.com", [NS_VERIFIED]: true } },
      { findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
      {} as NodeJS.ProcessEnv
    );

    expect(upsertUser).toHaveBeenCalledWith("user-1", "namespaced@example.com");
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
      { findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
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
      { findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
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
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser
        },
        {} as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    expect(upsertUser).not.toHaveBeenCalled();
  });

  it("opens no account from an address the Action marks unconfirmed", async () => {
    const upsertUser = vi.fn();

    await expect(
      prepareAuthenticatedUser(
        {
          ...user("jwt"),
          claims: { [NS]: "unconfirmed@example.com", [NS_VERIFIED]: false }
        },
        { findExistingUser: vi.fn().mockResolvedValue(null), upsertUser },
        {} as NodeJS.ProcessEnv
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
        findExistingUser: vi.fn().mockResolvedValue({ email: "known@example.com" }),
        upsertUser
      },
      {} as NodeJS.ProcessEnv
    );

    expect(upsertUser).not.toHaveBeenCalled();
    expect(email).toBe("known@example.com");
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
          findExistingUser: vi.fn().mockResolvedValue(null),
          upsertUser: vi.fn().mockRejectedValue(new EmailAlreadyLinkedError())
        },
        {} as NodeJS.ProcessEnv
      )
    ).rejects.toBeInstanceOf(EmailAlreadyLinkedError);
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
        findExistingUser: vi.fn().mockResolvedValue(null),
        upsertUser: vi.fn()
      },
      {} as NodeJS.ProcessEnv
    );

    expect(email).toBe("confirmed@example.com");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ prepareAuthenticatedUser: vi.fn() }));
vi.mock("../../../src/auth/identity.js", () => identity);

import { ACCOUNT_UNAVAILABLE_MESSAGE, registerLetterTools } from "../../../src/mcp/registerTools.js";
import {
  VERIFIED_EMAIL_MESSAGE,
  VerifiedEmailRequiredError
} from "../../../src/auth/verifiedEmail.js";
import {
  EMAIL_ALREADY_LINKED_MESSAGE,
  EmailAlreadyLinkedError
} from "../../../src/services/userService.js";
import { ACCOUNT_ERASED_MESSAGE, AccountErasedError } from "../../../src/auth/accountErased.js";

/**
 * A caller who has no account and cannot be given one.
 *
 * Before this, the failure to open an account was logged and the tools were
 * registered anyway, so the customer met it again in whichever table wrote
 * first - a balance of 0, an address save that matched nothing, a draft dying
 * on a foreign key. Now every tool answers with the one sentence, and nothing
 * reaches the service layer at all.
 */

const TOOLS = [
  { name: "get_account_balance", description: "Balance", readOnly: true, meta: {} },
  { name: "send_letter", description: "Send", readOnly: false, meta: {} }
];

async function registerWithRefusal(error: Error | null) {
  vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
  vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid profile email mail:read mail:draft mail:send");
  identity.prepareAuthenticatedUser.mockReset();
  if (error) identity.prepareAuthenticatedUser.mockRejectedValue(error);
  else identity.prepareAuthenticatedUser.mockResolvedValue("person@example.com");

  const handlers = new Map<string, (args: Record<string, unknown>, extra: any) => Promise<any>>();
  const mcpServer = {
    registerResource: vi.fn(),
    registerTool: vi.fn((name: string, _definition: unknown, handler: any) => {
      handlers.set(name, handler);
    })
  };
  const appServer = {
    listTools: () => TOOLS,
    execute: vi.fn(async () => ({ result: { lettersRemaining: 0 }, meta: {} }))
  };

  await registerLetterTools(mcpServer as any, appServer as any, {
    userId: "auth0|no-account",
    claims: {},
    token: "token",
    authType: "jwt" as const,
    scopes: ["mail:read", "mail:draft", "mail:send"]
  });

  return { handlers, appServer };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a tool call from a caller with no account", () => {
  it("answers every tool with the sentence, and runs nothing", async () => {
    const { handlers, appServer } = await registerWithRefusal(new VerifiedEmailRequiredError());

    for (const tool of TOOLS) {
      const handler = handlers.get(tool.name);
      expect(handler, `${tool.name} was not registered`).toBeDefined();
      const result = await handler!({}, { _meta: {} });

      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: VERIFIED_EMAIL_MESSAGE }]
      });
    }

    // The point of holding the refusal: the service layer is never reached, so
    // there is no foreign key left to fail and no half-written state.
    expect(appServer.execute).not.toHaveBeenCalled();
  });

  it("names a conflicting address rather than reporting it as a refusal", async () => {
    const { handlers } = await registerWithRefusal(new EmailAlreadyLinkedError());

    const result = await handlers.get("send_letter")!({}, { _meta: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(EMAIL_ALREADY_LINKED_MESSAGE);
  });

  it("answers every tool for an erased account with its sentence, runs nothing, and logs no failure (#289)", async () => {
    const logged: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(value => {
      logged.push(String(value));
    });
    const { handlers, appServer } = await registerWithRefusal(new AccountErasedError());
    error.mockRestore();

    for (const tool of TOOLS) {
      const result = await handlers.get(tool.name)!({}, { _meta: {} });
      expect(result).toEqual({ isError: true, content: [{ type: "text", text: ACCOUNT_ERASED_MESSAGE }] });
    }
    expect(appServer.execute).not.toHaveBeenCalled();
    expect(logged.filter(line => line.includes("auth.user_preparation_failed"))).toEqual([]);
  });

  it("on a long-lived session, refuses an account erased after the connection opened (#446 review)", async () => {
    vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
    vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid profile email mail:read mail:draft mail:send");
    identity.prepareAuthenticatedUser.mockReset();
    // Fine when the stream opened, erased before the call.
    identity.prepareAuthenticatedUser
      .mockResolvedValueOnce("person@example.com")
      .mockRejectedValue(new AccountErasedError());
    const handlers = new Map<string, (args: Record<string, unknown>, extra: any) => Promise<any>>();
    const mcpServer = {
      registerResource: vi.fn(),
      registerTool: vi.fn((name: string, _config: unknown, handler: any) => handlers.set(name, handler))
    };
    const appServer = { listTools: () => TOOLS, execute: vi.fn() };

    await registerLetterTools(
      mcpServer as never,
      appServer as never,
      {
        userId: "auth0|erased-mid-session",
        claims: {},
        token: "token",
        authType: "jwt" as const,
        scopes: ["mail:read", "mail:draft", "mail:send"]
      },
      { recheckAccountPerCall: true }
    );
    const result = await handlers.get("send_letter")!({}, { _meta: {} });

    expect(result).toEqual({ isError: true, content: [{ type: "text", text: ACCOUNT_ERASED_MESSAGE }] });
    expect(appServer.execute).not.toHaveBeenCalled();
  });

  it("on a long-lived session, follows each call's own answer rather than the one from connection time", async () => {
    vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
    vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid profile email mail:read mail:draft mail:send");
    identity.prepareAuthenticatedUser.mockReset();
    // Refused when the stream opened, fine by the call.
    identity.prepareAuthenticatedUser
      .mockRejectedValueOnce(new VerifiedEmailRequiredError())
      .mockResolvedValue("person@example.com");
    const handlers = new Map<string, (args: Record<string, unknown>, extra: any) => Promise<any>>();
    const mcpServer = {
      registerResource: vi.fn(),
      registerTool: vi.fn((name: string, _config: unknown, handler: any) => handlers.set(name, handler))
    };
    const appServer = {
      listTools: () => TOOLS,
      execute: vi.fn(async () => ({ result: { lettersRemaining: 0 }, meta: {} }))
    };

    await registerLetterTools(
      mcpServer as never,
      appServer as never,
      { userId: "auth0|confirmed-later", claims: {}, token: "token", authType: "jwt" as const, scopes: ["mail:read", "mail:draft", "mail:send"] },
      { recheckAccountPerCall: true }
    );
    await handlers.get("get_account_balance")!({}, { _meta: {} });

    expect(appServer.execute).toHaveBeenCalledTimes(1);
  });

  it("on a long-lived session, does not run a call whose account cannot be read", async () => {
    vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
    vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid profile email mail:read mail:draft mail:send");
    identity.prepareAuthenticatedUser.mockReset();
    identity.prepareAuthenticatedUser
      .mockResolvedValueOnce("person@example.com")
      .mockRejectedValue(new Error("connection terminated"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = new Map<string, (args: Record<string, unknown>, extra: any) => Promise<any>>();
    const mcpServer = {
      registerResource: vi.fn(),
      registerTool: vi.fn((name: string, _config: unknown, handler: any) => handlers.set(name, handler))
    };
    const appServer = { listTools: () => TOOLS, execute: vi.fn() };

    await registerLetterTools(
      mcpServer as never,
      appServer as never,
      { userId: "auth0|unreadable", claims: {}, token: "token", authType: "jwt" as const, scopes: ["mail:read", "mail:draft", "mail:send"] },
      { recheckAccountPerCall: true }
    );
    const result = await handlers.get("send_letter")!({}, { _meta: {} });
    error.mockRestore();

    expect(result).toEqual({ isError: true, content: [{ type: "text", text: ACCOUNT_UNAVAILABLE_MESSAGE }] });
    expect(appServer.execute).not.toHaveBeenCalled();
  });

  it("decides the account once per server when not asked to recheck", async () => {
    const { handlers } = await registerWithRefusal(null);
    await handlers.get("get_account_balance")!({}, { _meta: {} });
    await handlers.get("get_account_balance")!({}, { _meta: {} });
    expect(identity.prepareAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it("says nothing about the caller in what it answers", async () => {
    // Both messages are fixed constants. This is what keeps them safe to hand
    // back whole, as BETA_ACCESS_MESSAGE is.
    const { handlers } = await registerWithRefusal(new VerifiedEmailRequiredError());

    const result = await handlers.get("send_letter")!({}, { _meta: {} });

    expect(result.content[0].text).not.toContain("auth0|no-account");
    expect(result.content[0].text).not.toContain("token");
  });

  it("does not also report itself as a database failure", async () => {
    // Neither refusal carries a pg code, so classifyDiagnosticError calls both
    // `database_error`. Logging the refusal a second time here - it is already
    // reported by name where it was decided - made a refused customer look
    // like a database outage on every request they made.
    const logged: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(value => {
      logged.push(String(value));
    });

    await registerWithRefusal(new VerifiedEmailRequiredError());

    error.mockRestore();
    expect(logged.filter(line => line.includes("auth.user_preparation_failed"))).toEqual([]);
  });

  it("still reports a failure that is not a refusal", async () => {
    // Guards the assertion above: the log must not have been dropped outright.
    const logged: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(value => {
      logged.push(String(value));
    });

    await registerWithRefusal(new Error("connection terminated"));

    error.mockRestore();
    expect(logged.some(line => line.includes("auth.user_preparation_failed"))).toBe(true);
  });

  it("lets an ordinary call through when the account is fine", async () => {
    // Guards the assertions above: the refusal must not be the default.
    const { handlers, appServer } = await registerWithRefusal(null);

    const result = await handlers.get("get_account_balance")!({}, { _meta: {} });

    expect(result.isError).toBeUndefined();
    expect(appServer.execute).toHaveBeenCalledTimes(1);
  });

  it("does not call a database failure a refusal, and does not run the tool on an account nobody could read", async () => {
    // A database that will not answer is not "you have no account", so the
    // sentence says to try again. It does not run the tool either: the account
    // could be a tombstone (#289), and the call would fail a query later anyway
    // (#446 review).
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handlers, appServer } = await registerWithRefusal(new Error("connection terminated"));
    error.mockRestore();

    const result = await handlers.get("get_account_balance")!({}, { _meta: {} });

    expect(result).toEqual({ isError: true, content: [{ type: "text", text: ACCOUNT_UNAVAILABLE_MESSAGE }] });
    expect(result.content[0].text).not.toBe(VERIFIED_EMAIL_MESSAGE);
    expect(appServer.execute).not.toHaveBeenCalled();
  });
});

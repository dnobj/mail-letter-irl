import { afterEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ prepareAuthenticatedUser: vi.fn() }));
vi.mock("../../../src/auth/identity.js", () => identity);

import { registerLetterTools } from "../../../src/mcp/registerTools.js";
import {
  VERIFIED_EMAIL_MESSAGE,
  VerifiedEmailRequiredError
} from "../../../src/auth/verifiedEmail.js";
import {
  EMAIL_ALREADY_LINKED_MESSAGE,
  EmailAlreadyLinkedError
} from "../../../src/services/userService.js";

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

  it("says nothing about the caller in what it answers", async () => {
    // Both messages are fixed constants. This is what keeps them safe to hand
    // back whole, as BETA_ACCESS_MESSAGE is.
    const { handlers } = await registerWithRefusal(new VerifiedEmailRequiredError());

    const result = await handlers.get("send_letter")!({}, { _meta: {} });

    expect(result.content[0].text).not.toContain("auth0|no-account");
    expect(result.content[0].text).not.toContain("token");
  });

  it("lets an ordinary call through when the account is fine", async () => {
    // Guards the assertions above: the refusal must not be the default.
    const { handlers, appServer } = await registerWithRefusal(null);

    const result = await handlers.get("get_account_balance")!({}, { _meta: {} });

    expect(result.isError).toBeUndefined();
    expect(appServer.execute).toHaveBeenCalledTimes(1);
  });

  it("does not hold a failure that is not a refusal", async () => {
    // A database that will not answer is not "you have no account": the tools
    // must still run, and fail on their own terms.
    const { handlers, appServer } = await registerWithRefusal(new Error("connection terminated"));

    await handlers.get("get_account_balance")!({}, { _meta: {} });

    expect(appServer.execute).toHaveBeenCalledTimes(1);
  });
});

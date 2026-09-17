import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/identity.js", () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue(undefined)
}));

import { buildDuplicateMailToolResult, registerLetterTools } from "../../../src/mcp/registerTools.js";
import { DuplicateMailError } from "../../../src/services/duplicateMailService.js";

/**
 * A send or checkout refused because the same mail went out recently (#412).
 *
 * The refusal is an error result, so the model reads "nothing happened", and
 * it carries the details the preview cards show in _meta. Every other failure
 * still reaches the SDK as a throw.
 */

const duplicate = { kind: "paid" as const, mailType: "postcard" as const, recipientName: "Sam Rivera", ageSeconds: 7_325 };

async function registeredSendPostcard(execute: (...args: unknown[]) => Promise<unknown>) {
  vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
  vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid profile email mail:read mail:draft mail:send");
  let callback: ((args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<any>) | undefined;
  const mcpServer = {
    registerResource: vi.fn(),
    registerTool: vi.fn((name: string, _definition: unknown, handler: typeof callback) => {
      if (name === "send_postcard") callback = handler;
    })
  };
  const appServer = {
    listTools: () => [{ name: "send_postcard", description: "Send a postcard", readOnly: false, meta: {} }],
    execute: vi.fn(execute)
  };
  await registerLetterTools(mcpServer as any, appServer as any, {
    userId: "auth0|test",
    claims: {},
    token: "token",
    authType: "jwt" as const,
    scopes: ["mail:read", "mail:draft", "mail:send"]
  });
  expect(callback).toBeDefined();
  return { callback: callback!, appServer };
}

describe("duplicate mail refusals", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds an error result with the details in _meta", () => {
    const result = buildDuplicateMailToolResult(new DuplicateMailError(duplicate, "Possible duplicate: text"));
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Possible duplicate: text" }],
      _meta: {
        "letterirl/duplicateMail": {
          kind: "paid",
          mailType: "postcard",
          recipientName: "Sam Rivera",
          ageMinutes: 122
        }
      }
    });
  });

  it("never reports a negative age", () => {
    const result = buildDuplicateMailToolResult(new DuplicateMailError({ ...duplicate, ageSeconds: -30 }));
    expect(result._meta["letterirl/duplicateMail"].ageMinutes).toBe(0);
  });

  it("returns the refusal from the tool callback instead of throwing", async () => {
    const { callback, appServer } = await registeredSendPostcard(async () => {
      throw new DuplicateMailError(duplicate);
    });

    const result = await callback({ draftId: "draft-1", confirm: true }, {});

    expect(appServer.execute).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Possible duplicate: This same postcard to Sam Rivera/);
    expect(result._meta["letterirl/duplicateMail"]).toMatchObject({ kind: "paid", ageMinutes: 122 });
    expect(result.structuredContent).toBeUndefined();
  });

  it("still throws every other failure", async () => {
    const failure = Object.assign(new Error("Draft has expired"), { code: "DRAFT_EXPIRED" });
    const { callback } = await registeredSendPostcard(async () => {
      throw failure;
    });

    await expect(callback({ draftId: "draft-1", confirm: true }, {})).rejects.toBe(failure);
  });

  it("does not treat a look-alike error as a refusal", async () => {
    const lookalike = Object.assign(new Error("Possible duplicate: no"), { code: "DUPLICATE_RECENT_MAIL" });
    const { callback } = await registeredSendPostcard(async () => {
      throw lookalike;
    });

    await expect(callback({ draftId: "draft-1", confirm: true }, {})).rejects.toBe(lookalike);
  });
});

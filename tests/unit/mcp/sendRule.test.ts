import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/identity.js", () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue(undefined)
}));

import {
  buildToolMeta,
  CARD_ONLY_SEND_TOOLS,
  howToSendText,
  registerLetterTools,
  sendLinkText
} from "../../../src/mcp/registerTools.js";
import {
  buildServerInstructions,
  LETTER_IRL_SERVER_INSTRUCTIONS
} from "../../../src/mcp/serverInstructions.js";
import { LetterIrlServer } from "../../../src/server.js";
import type { AuthenticatedUser } from "../../../src/auth/tokenValidator.js";
import * as diagnostics from "../../../src/utils/diagnosticLog.js";

/**
 * The send rule (#470), where the MCP server applies it.
 *
 * With the rule on, a send tool is card-only: the model of an app that honours
 * card-only tools cannot see it, and an app that cannot be trusted to (a token,
 * an app with no card, an app we do not know) gets the link where the person
 * sends, never a send. With the rule off nothing changes. These drive the real
 * registration wrapper; only the tool layer (appServer.execute) is faked.
 */

const DRAFT_ID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const ALL_SCOPES = ["mail:read", "mail:draft", "mail:send"];

const LINK = {
  draftId: DRAFT_ID,
  mailType: "letter",
  confirmationUrl: `https://site.example/confirm/${DRAFT_ID}`,
  expiresAtISO: "2026-09-26T12:00:00.000Z",
  recipientSummary: { name: "Sam Rivera", city: "Austin", state: "TX" }
};

const SENT = {
  orderId: "order-1",
  currentStatus: "accepted",
  statusTimeline: [],
  recipientSummary: { name: "Sam Rivera", city: "Austin", state: "TX" },
  lettersRemaining: 3,
  trackingSupport: "estimated_only"
};

const TOOLS = ["send_letter", "send_postcard", "request_send", "quote_and_preview_letter", "get_account_balance"].map(
  (name) => ({ name, description: name, readOnly: false, meta: {} })
);

const chatgpt = (scopes = ALL_SCOPES): AuthenticatedUser => ({
  userId: "auth0|user",
  claims: { azp: "https://chatgpt.com/oauth/AbC123/client.json" },
  token: "t",
  authType: "jwt",
  scopes
});
const claude = (scopes = ALL_SCOPES): AuthenticatedUser => ({
  userId: "auth0|user",
  claims: { azp: "https://claude.ai/oauth/mcp-oauth-client-metadata" },
  token: "t",
  authType: "jwt",
  scopes
});
const pat: AuthenticatedUser = { userId: "auth0|user", claims: {}, token: "t", authType: "pat", scopes: [] };

type Callback = (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<any>;

async function register(authInfo: AuthenticatedUser) {
  vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
  vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid profile email mail:read mail:draft mail:send");
  const callbacks = new Map<string, Callback>();
  const definitions = new Map<string, any>();
  const mcpServer = {
    registerResource: vi.fn(),
    registerTool: vi.fn((name: string, definition: unknown, handler: Callback) => {
      callbacks.set(name, handler);
      definitions.set(name, definition);
    })
  };
  const execute = vi.fn(async ({ toolName }: { toolName: string }) => {
    if (toolName === "request_send") return { result: LINK, meta: {} };
    if (toolName === "send_letter" || toolName === "send_postcard") return { result: SENT, meta: {} };
    if (toolName === "quote_and_preview_letter") return { result: { draftId: DRAFT_ID, lettersRequired: 1 }, meta: {} };
    throw new Error(`unexpected tool ${toolName}`);
  });
  await registerLetterTools(mcpServer as any, { listTools: () => TOOLS, execute } as any, authInfo);
  return { callbacks, definitions, execute };
}

describe("the send rule in the MCP server (#470)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(diagnostics, "writeDiagnostic").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    writeSpy.mockRestore();
  });

  describe("with the rule off", () => {
    it("sends from any app, as before", async () => {
      const { callbacks, execute } = await register(claude());
      const result = await callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {});
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ toolName: "send_letter" }));
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ orderId: "order-1" });
    });

    it("leaves the send tools visible and the preview narration as it was", async () => {
      const { callbacks, definitions } = await register(chatgpt());
      expect(definitions.get("send_letter")._meta["openai/visibility"]).toBeUndefined();
      expect(definitions.get("send_letter")._meta.ui.visibility).toBeUndefined();
      const preview = await callbacks.get("quote_and_preview_letter")!({}, {});
      expect(preview.content[0].text).not.toContain("request_send");
    });
  });

  describe("with the rule on", () => {
    beforeEach(() => vi.stubEnv("LETTER_IRL_SEND_CONFIRMATION_ENABLED", "true"));

    it("still sends from ChatGPT, whose card is the only caller that can reach the tool", async () => {
      const { callbacks, execute } = await register(chatgpt());
      const result = await callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {});
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ toolName: "send_letter" }));
      expect(result.structuredContent).toMatchObject({ orderId: "order-1" });
    });

    it.each([
      ["Claude", claude()],
      ["a personal access token", pat]
    ])("answers %s with the link where the person sends, and sends nothing", async (_label, authInfo) => {
      for (const tool of ["send_letter", "send_postcard"]) {
        const { callbacks, execute } = await register(authInfo);
        const result = await callbacks.get(tool)!({ draftId: DRAFT_ID, confirm: true, sendAnotherCopy: true }, {});

        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledWith({ toolName: "request_send", input: { draftId: DRAFT_ID }, userId: "auth0|user" });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(result.content[0].text).toBe(
          `Not sent: Letter IRL sends mail only when the person sends it. ${sendLinkText(LINK as any)}`
        );
      }
    });

    it("logs which app was sent to the link", async () => {
      const { callbacks } = await register(claude());
      await callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {});
      expect(writeSpy).toHaveBeenCalledWith("info", "send.link_instead", { client: "claude", mailType: "letter" });
    });

    it("gives a token that can draft but not send the link, not a scope error", async () => {
      const { callbacks, execute } = await register(claude(["mail:read", "mail:draft"]));
      const result = await callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {});
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ toolName: "request_send" }));
      expect(result.content[0].text).toMatch(/^Not sent:/);
    });

    it("asks a token that cannot draft for the link's own scope", async () => {
      const { callbacks, execute } = await register(claude(["mail:read"]));
      const result = await callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {});
      expect(execute).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("mail:draft");
      expect(JSON.stringify(result)).not.toContain("mail:send");
    });

    it("keeps the send scope for ChatGPT, which really sends", async () => {
      const { callbacks, execute } = await register(chatgpt(["mail:read", "mail:draft"]));
      const result = await callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {});
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).toContain("mail:send");
    });

    it("passes a refusal to give the link straight back", async () => {
      const refused = Object.assign(new Error("This preview has expired."), { code: "DRAFT_EXPIRED" });
      const { callbacks, execute } = await register(pat);
      execute.mockRejectedValueOnce(refused);
      await expect(callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {})).rejects.toBe(refused);
    });

    it("makes the send tools card-only, and nothing else", async () => {
      const { definitions } = await register(chatgpt());
      for (const tool of CARD_ONLY_SEND_TOOLS) {
        const meta = definitions.get(tool)._meta;
        expect(meta["openai/visibility"]).toBe("private");
        expect(meta["anthropic/requiresUserInteraction"]).toBe(true);
        expect(meta.ui.visibility).toEqual(["app"]);
      }
      for (const tool of ["request_send", "quote_and_preview_letter", "get_account_balance"]) {
        const meta = definitions.get(tool)._meta;
        expect(meta["openai/visibility"]).toBeUndefined();
        expect(meta.ui.visibility).toBeUndefined();
      }
    });

    it("tells the model how the person sends, with the draft id, after every preview", async () => {
      const { callbacks } = await register(claude());
      const preview = await callbacks.get("quote_and_preview_letter")!({}, {});
      expect(preview.content[0].text.endsWith(` ${howToSendText(DRAFT_ID)}`)).toBe(true);
      expect(preview.content[0].text).toContain(`draftId ${DRAFT_ID}`);
    });

    it("narrates the link without claiming anything was sent", async () => {
      const { callbacks } = await register(claude());
      const result = await callbacks.get("request_send")!({ draftId: DRAFT_ID }, {});
      expect(result.content[0].text).toBe(sendLinkText(LINK as any));
      expect(result.content[0].text).toContain("Nothing is sent until they press Send there");
      expect(result.structuredContent).toMatchObject({ confirmationUrl: LINK.confirmationUrl });
    });
  });

  it("builds the card-only metadata only for the send tools, only with the rule on", () => {
    expect(buildToolMeta("send_letter", {}, true, false)["openai/visibility"]).toBeUndefined();
    expect(buildToolMeta("send_letter", {}, true, true)["openai/visibility"]).toBe("private");
    expect(buildToolMeta("create_mail_checkout", {}, true, true)["openai/visibility"]).toBeUndefined();
  });
});

describe("request_send's place in the tool list (#470)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is listed only while the rule is on", () => {
    expect(new LetterIrlServer().listTools().map((tool) => tool.name)).not.toContain("request_send");
    vi.stubEnv("LETTER_IRL_SEND_CONFIRMATION_ENABLED", "true");
    expect(new LetterIrlServer().listTools().map((tool) => tool.name)).toContain("request_send");
  });
});

describe("the server instructions under the send rule (#470)", () => {
  it("are unchanged with the rule off", () => {
    expect(buildServerInstructions(false)).toBe(LETTER_IRL_SERVER_INSTRUCTIONS);
    expect(LETTER_IRL_SERVER_INSTRUCTIONS).toContain("Only call send_letter or send_postcard after the user has reviewed");
  });

  it("tell the model it cannot send, and how the person does", () => {
    const on = buildServerInstructions(true);
    expect(on).not.toContain("Only call send_letter");
    expect(on).toContain("Mail is sent only by the person, never by you");
    expect(on).toContain("call request_send and give them its link");
    // Only the one line differs.
    const before = LETTER_IRL_SERVER_INSTRUCTIONS.split("\n");
    const after = on.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, index) => line !== before[index])).toHaveLength(1);
  });
});

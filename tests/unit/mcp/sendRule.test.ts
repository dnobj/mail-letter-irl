import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/identity.js", () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue(undefined)
}));

// A profile a test can put in place of the one resolved from the token: today
// every profile has the same card and purchase flags, so only a made-up one can
// show the rule reading the right flag for each tool.
const profileOverride = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("../../../src/auth/clientProfiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auth/clientProfiles.js")>();
  return {
    ...actual,
    resolveClientProfile: (user: Parameters<typeof actual.resolveClientProfile>[0]) =>
      (profileOverride.value as ReturnType<typeof actual.resolveClientProfile> | null) ??
      actual.resolveClientProfile(user)
  };
});

import {
  buildToolMeta,
  CARD_ONLY_SEND_TOOLS,
  howToSendText,
  PAY_AND_SEND_TOOL,
  registerLetterTools,
  sendLinkText
} from "../../../src/mcp/registerTools.js";
import { prepareAuthenticatedUser } from "../../../src/auth/identity.js";
import { AccountErasedError } from "../../../src/auth/accountErased.js";
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

const CHECKOUT = { orderId: "order-2", checkoutUrl: "https://checkout.example/pay", status: "awaiting_payment" };

const TOOLS = [
  "send_letter",
  "send_postcard",
  "create_mail_checkout",
  "request_send",
  "quote_and_preview_letter",
  "get_account_balance"
].map((name) => ({ name, description: name, readOnly: false, meta: {} }));

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
    if (toolName === "create_mail_checkout") return { result: CHECKOUT, meta: {} };
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
        // The whole point of the answer: the page and how long it lasts.
        expect(result.content[0].text).toContain(LINK.confirmationUrl);
        expect(result.content[0].text).toContain(LINK.expiresAtISO);
      }
    });

    it.each([
      ["Claude", claude()],
      ["a personal access token", pat]
    ])("answers Pay & Send from %s, which may not take a purchase, with the link too", async (_label, authInfo) => {
      const { callbacks, execute } = await register(authInfo);
      const result = await callbacks.get(PAY_AND_SEND_TOOL)!({ draftId: DRAFT_ID, sendAnotherCopy: true }, {});
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith({ toolName: "request_send", input: { draftId: DRAFT_ID }, userId: "auth0|user" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(LINK.confirmationUrl);
    });

    it("reads the card flag for a send and the purchase flag for Pay & Send", async () => {
      // Claude once its cards work (#474): it keeps card-only tools from its
      // model, but may never take a purchase (#475).
      profileOverride.value = { name: "claude", rendersCards: true, honorsCardOnlyTools: true, inAppPurchases: false };
      try {
        const { callbacks, execute } = await register(claude());
        await callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {});
        expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: "send_letter" }));
        const checkout = await callbacks.get(PAY_AND_SEND_TOOL)!({ draftId: DRAFT_ID }, {});
        expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: "request_send" }));
        expect(checkout.content[0].text).toContain(LINK.confirmationUrl);
      } finally {
        profileOverride.value = null;
      }
    });

    it("answers Pay & Send with the link where purchases are allowed but no card shows the preview", async () => {
      profileOverride.value = { name: "generic", rendersCards: false, honorsCardOnlyTools: false, inAppPurchases: true };
      try {
        const { callbacks, execute } = await register(claude());
        await callbacks.get(PAY_AND_SEND_TOOL)!({ draftId: DRAFT_ID }, {});
        expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ toolName: "request_send" }));
      } finally {
        profileOverride.value = null;
      }
    });

    it("still starts Pay & Send in ChatGPT, where the person sees the card and pays", async () => {
      const { callbacks, execute } = await register(chatgpt());
      const result = await callbacks.get(PAY_AND_SEND_TOOL)!({ draftId: DRAFT_ID }, {});
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ toolName: PAY_AND_SEND_TOOL }));
      expect(result.structuredContent).toMatchObject({ checkoutUrl: CHECKOUT.checkoutUrl });
    });

    it("refuses an erased account before any link", async () => {
      vi.mocked(prepareAuthenticatedUser).mockRejectedValueOnce(new AccountErasedError());
      const { callbacks, execute } = await register(claude());
      const result = await callbacks.get("send_letter")!({ draftId: DRAFT_ID, confirm: true }, {});
      expect(execute).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(LINK.confirmationUrl);
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
      expect(preview.content[0].text.endsWith(` ${howToSendText(DRAFT_ID, false)}`)).toBe(true);
      expect(preview.content[0].text).toContain(`call request_send with draftId ${DRAFT_ID}`);
      expect(preview.content[0].text).not.toContain("preview card");
    });

    it("points ChatGPT at the card's Send button, and at the link only if the card is missing", async () => {
      const { callbacks } = await register(chatgpt());
      const preview = await callbacks.get("quote_and_preview_letter")!({}, {});
      expect(preview.content[0].text.endsWith(` ${howToSendText(DRAFT_ID, true)}`)).toBe(true);
      expect(preview.content[0].text).toContain("Send on the preview card");
      expect(preview.content[0].text).toContain(`Only if the card is not showing, call request_send with draftId ${DRAFT_ID}`);
    });

    it("adds nothing to a preview that carries no draft id", async () => {
      const { callbacks, execute } = await register(claude());
      execute.mockResolvedValueOnce({ result: { lettersRequired: 1 }, meta: {} } as any);
      const preview = await callbacks.get("quote_and_preview_letter")!({}, {});
      expect(preview.content[0].text).not.toContain("request_send");
    });

    it("narrates the link without claiming anything was sent", async () => {
      const { callbacks } = await register(claude());
      const result = await callbacks.get("request_send")!({ draftId: DRAFT_ID }, {});
      expect(result.content[0].text).toBe(sendLinkText(LINK as any));
      expect(result.content[0].text).toContain("Nothing is sent until they press Send there");
      expect(result.structuredContent).toMatchObject({ confirmationUrl: LINK.confirmationUrl });
    });
  });

  it("words the link with the page, the mail, the recipient and its end", () => {
    const text = sendLinkText({ ...LINK, mailType: "postcard" } as any);
    expect(text).toContain(`open ${LINK.confirmationUrl} to check the postcard to Sam Rivera`);
    expect(text).toContain("Nothing is sent until they press Send there.");
    expect(text).toContain(`The link works until ${LINK.expiresAtISO}.`);
    expect(sendLinkText({ ...LINK, recipientSummary: { name: "", city: "", state: "" } } as any)).toContain("to check the letter and send");
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

// The instructions as they were before the send rule (8465b1f), verbatim. With
// the rule off they must not change by a character.
const PRE_470_INSTRUCTIONS = [
  "Letter IRL drafts, previews, and sends real physical letters and postcards in the U.S.",
  "Always create a preview draft before sending. Preview tools are free drafts; they do not send mail.",
  "Only call send_letter or send_postcard after the user has reviewed a draft and clearly confirms sending.",
  "Do not say mail has been sent unless the send tool succeeds.",
  "If send_letter, send_postcard or create_mail_checkout says the same mail was already sent, paid for, or is awaiting payment, tell the user and repeat the call with sendAnotherCopy: true only if they ask for another copy.",
  "A preview exists only when the preview tool's result includes a draftId, and a checkout only when its result includes a checkoutUrl. If a Letter IRL tool call returns no result, say it did not complete: the preview card offers a Create my preview button, or offer to try again. Never describe a draft, order or checkout you did not receive.",
  "Use saved return addresses when available, and ask for missing real U.S. mailing addresses when required.",
  "For image mail, reuse existing conversation images or hosted imageUrl values before opening upload_image.",
  "For an image request addressed to Letter IRL, call generate_image_for_mail and follow its response exactly: it either generates the image in-turn using the user's remaining Letter IRL image generations, or returns routing guidance with a copy-ready prompt. Never refuse an image request. For image requests not addressed to Letter IRL, use ChatGPT's built-in image generation (image_gen); its images attach to Letter IRL previews directly.",
  "If a specific image fails to hand off to a preview tool, open upload_image so the user can pick it from their ChatGPT library or upload it - that preserves the exact image they approved.",
  "For unsupported formats, integrations, or product ideas, offer submit_feature_request instead of promising support.",
  "No tool can request or issue a refund. If the user asks for one, tell them to email support@letterirl.com from the email on their Letter IRL account, quoting the order id from get_purchase_status; refunds are decided by a person, so never promise, estimate, or deny a refund or an amount."
].join("\n");

describe("the server instructions under the send rule (#470)", () => {
  it("are unchanged with the rule off", () => {
    expect(buildServerInstructions(false)).toBe(PRE_470_INSTRUCTIONS);
    expect(buildServerInstructions(false)).toBe(LETTER_IRL_SERVER_INSTRUCTIONS);
    expect(LETTER_IRL_SERVER_INSTRUCTIONS).toContain("Only call send_letter or send_postcard after the user has reviewed");
  });

  it("tell the model it cannot send, and how the person does", () => {
    const on = buildServerInstructions(true);
    expect(on).not.toContain("Only call send_letter");
    expect(on).toContain("Mail is sent only by the person, never by you");
    expect(on).toContain("call request_send and give them its link");
    // Another copy is the card's or the page's to offer, not the model's.
    expect(on).not.toContain("If send_letter, send_postcard or create_mail_checkout says");
    expect(on).toContain("the preview card or the confirmation page offers another copy itself");
    // Only those two lines differ.
    const before = LETTER_IRL_SERVER_INSTRUCTIONS.split("\n");
    const after = on.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, index) => line !== before[index])).toHaveLength(2);
  });
});

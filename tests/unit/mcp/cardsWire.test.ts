/**
 * The cards on the wire, per app (#474).
 *
 * Claude refuses to draw a card whose ui.domain is not its own hashed form,
 * and ChatGPT wants our API origin, so the card address is per app: ChatGPT
 * keeps it, every other app gets none. A card on the shared bridge is served
 * with the bridge inlined. And where the app is not proven to hand a card the
 * result's _meta, the getting-started copy also travels in structuredContent.
 *
 * This drives the real MCP server for a ChatGPT token and for a Claude token
 * with a real client. Only the account preparation and the tool execution are
 * stubbed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/identity.js", () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue("person@example.com")
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../../src/mcp/httpServer.js";
import { widgetTemplateUri } from "../../../src/mcp/widgetUris.js";
import { type ClientProfile } from "../../../src/auth/clientProfiles.js";
import { LetterIrlServer } from "../../../src/server.js";
import { getStartedTool } from "../../../src/tools/getStarted.js";
import { partitionToolResult } from "../../../src/mcp/registerTools.js";

const APPS = {
  chatgpt: "https://chatgpt.com/oauth/abc/client.json",
  claude: "https://claude.ai/oauth/mcp-oauth-client-metadata"
} as const;

async function connect(app: keyof typeof APPS) {
  vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
  vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid email offline_access mail:read mail:draft mail:send");
  const real = new LetterIrlServer();
  const appServer = {
    listTools: (client: ClientProfile) => real.listTools(client),
    execute: vi.fn(async (request: { client?: ClientProfile }) => ({
      result: await getStartedTool.handler({}, { client: request.client } as never),
      meta: {}
    }))
  } as unknown as LetterIrlServer;
  const server = await createMcpServer(appServer, {
    userId: "auth0|test",
    claims: { azp: APPS[app] },
    token: "token",
    authType: "jwt",
    scopes: ["mail:read", "mail:draft", "mail:send"]
  });
  const client = new Client({ name: "cards-wire-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function readCard(app: keyof typeof APPS, name = "GetStartedCard") {
  const client = await connect(app);
  const { contents } = await client.readResource({ uri: widgetTemplateUri(name) });
  return contents[0] as { text: string; _meta: Record<string, any>; mimeType: string };
}

describe("the cards on the wire (#474)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gives ChatGPT our card address, and Claude none", async () => {
    const chatgpt = await readCard("chatgpt");
    expect(chatgpt._meta.ui.domain).toMatch(/^https:\/\//);
    expect(chatgpt._meta["openai/widgetDomain"]).toBe(chatgpt._meta.ui.domain);

    const claude = await readCard("claude");
    expect(claude._meta.ui).not.toHaveProperty("domain");
    expect(claude._meta).not.toHaveProperty("openai/widgetDomain");
    // Everything else is the same for both.
    expect(claude._meta.ui.csp).toEqual(chatgpt._meta.ui.csp);
    expect(claude.mimeType).toBe("text/html;profile=mcp-app");
  });

  it("serves the getting-started card with the bridge inlined, to every app", async () => {
    for (const app of ["chatgpt", "claude"] as const) {
      const card = await readCard(app);
      expect(card.text, app).not.toContain("<!-- letter-irl:host -->");
      expect(card.text, app).toContain("window.letterIrlHost = {");
      expect(card.text, app).toContain('"ui/initialize"');
    }
  });

  it("serves the preview cards to Claude on the bridge, stamped with their tool, with no card address", async () => {
    const cards = [
      ["LetterPreviewCard", "quote_and_preview_letter"],
      ["LetterHeaderImagePreviewCard", "quote_and_preview_letter_with_header_image"],
      ["LetterInlineImagePreviewCard", "quote_and_preview_letter_with_image"],
      ["PostcardPreviewCard", "quote_and_preview_postcard"]
    ];
    for (const [name, tool] of cards) {
      const card = await readCard("claude", name);
      expect(card.text, name).not.toContain("<!-- letter-irl:host -->");
      expect(card.text, name).toContain('"ui/initialize"');
      expect(card.text, name).toContain(`<meta name="letter-irl-preview-tool" content="${tool}" />`);
      expect(card._meta.ui, name).not.toHaveProperty("domain");
    }
  });

  it("keeps the getting-started copy in _meta for ChatGPT, and in structuredContent too for Claude", async () => {
    const fromChatgpt = await (await connect("chatgpt")).callTool({ name: "get_started", arguments: {} });
    expect(fromChatgpt.structuredContent).toEqual({});
    expect((fromChatgpt._meta as Record<string, unknown>).overview).toEqual(expect.any(String));

    const fromClaude = await (await connect("claude")).callTool({ name: "get_started", arguments: {} });
    const copy = fromClaude.structuredContent as Record<string, unknown>;
    expect(copy.overview).toEqual(expect.any(String));
    expect(copy.purchaseStep).toContain("/dashboard/letter-packs");
    expect(copy.examplePrompts).toEqual(expect.arrayContaining([expect.any(String)]));
    expect((fromClaude._meta as Record<string, unknown>).overview).toBe(copy.overview);
  });
});

describe("the card copy a result carries (#474)", () => {
  const result = {
    draftId: "draft-1",
    title: "Get Started with Letter IRL",
    overview: "o",
    purchaseStep: "p",
    examplePrompts: ["e"],
    previewHtml: "<p>letter</p>",
    headerImagePreview: "data:image/jpeg;base64,AAAA"
  };

  it("moves the copy and the previews to _meta by default, for ChatGPT", () => {
    const { structuredContent, _meta } = partitionToolResult(result, {});
    expect(structuredContent).toEqual({ draftId: "draft-1" });
    expect(_meta).toMatchObject({ overview: "o", previewHtml: "<p>letter</p>" });
  });

  it("keeps the small copy in structuredContent as well where _meta is unproven, never a preview", () => {
    const { structuredContent, _meta } = partitionToolResult(result, {}, true);
    expect(structuredContent).toEqual({
      draftId: "draft-1",
      title: "Get Started with Letter IRL",
      overview: "o",
      purchaseStep: "p",
      examplePrompts: ["e"]
    });
    expect(_meta).toMatchObject({ overview: "o", previewHtml: "<p>letter</p>", headerImagePreview: "data:image/jpeg;base64,AAAA" });
  });
});

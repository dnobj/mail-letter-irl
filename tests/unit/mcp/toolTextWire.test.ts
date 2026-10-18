/**
 * Tool text on the wire, per app (#484).
 *
 * modelFacingCopy.test.ts checks the words each app should read. This checks
 * that an app receives them: the MCP server built for a request from ChatGPT
 * or from Claude, driven by a real MCP client over an in-memory transport. The
 * calling app reaches three places: the instructions in the initialize result,
 * the titles and descriptions in tools/list, and the text of a tool result.
 * Only the account preparation and the tool execution are stubbed; the tool
 * list is the real one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/identity.js", () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue("person@example.com")
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../../src/mcp/httpServer.js";
import { buildServerInstructions } from "../../../src/mcp/serverInstructions.js";
import { clientProfileNamed, type ClientProfile } from "../../../src/auth/clientProfiles.js";
import { LetterIrlServer } from "../../../src/server.js";
import { getStartedTool } from "../../../src/tools/getStarted.js";

const APPS = {
  chatgpt: "https://chatgpt.com/oauth/abc/client.json",
  claude: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  vscode: "https://vscode.dev/oauth/client-metadata.json"
} as const;

async function connect(app: keyof typeof APPS, answer?: Record<string, unknown>) {
  vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
  vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid email offline_access mail:read mail:draft mail:send");
  vi.stubEnv("LETTER_IRL_WEBSITE_BASE_URL", "https://website.example");
  const real = new LetterIrlServer();
  // The real get_started, run with the app the call arrived with; or, given one, that answer.
  const execute = vi.fn(async (request: { toolName: string; client?: ClientProfile }) => ({
    result: answer ?? (await getStartedTool.handler({}, { client: request.client } as never)),
    meta: {}
  }));
  const appServer = {
    listTools: (client: ClientProfile) => real.listTools(client),
    execute
  } as unknown as LetterIrlServer;
  const server = await createMcpServer(appServer, {
    userId: "auth0|test",
    claims: { azp: APPS[app] },
    token: "token",
    authType: "jwt",
    scopes: ["mail:read", "mail:draft", "mail:send"]
  });
  const client = new Client({ name: "tool-text-wire-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, execute };
}

describe("tool text on the wire (#484)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["chatgpt", "claude"] as const)("gives %s its own instructions", async (app) => {
    const { client } = await connect(app);
    expect(client.getInstructions()).toBe(buildServerInstructions(false, clientProfileNamed(app)));
  });

  it("says what an upload's context takes, in every app (#474, r17)", async () => {
    for (const app of ["chatgpt", "claude"] as const) {
      const { client } = await connect(app);
      const { tools } = await client.listTools();
      for (const name of ["upload_image", "confirm_uploaded_image"]) {
        const context = (tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, { description?: string }>)
          ?.context;
        expect(context?.description, `${app} ${name}`).toBe(
          "What the photo is for: 'postcard', 'header_image' or 'inline_image'."
        );
      }
    }
  });

  it("gives every tool its short title, in every app", async () => {
    for (const app of ["chatgpt", "claude"] as const) {
      const listed = new LetterIrlServer().listTools(clientProfileNamed(app));
      const titles = new Map(listed.map((tool) => [tool.name, tool.title]));
      const { client } = await connect(app);
      const { tools } = await client.listTools();
      expect(tools.length).toBe(titles.size);
      for (const tool of tools) {
        expect(tool.title, `${app} ${tool.name}`).toBe(titles.get(tool.name));
        expect(tool.title, `${app} ${tool.name}`).not.toBe(tool.description);
      }
    }
  });

  it("lists get_draft_status to every app, for the card only (#474)", async () => {
    for (const app of ["chatgpt", "claude", "vscode"] as const) {
      const { client } = await connect(app);
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "get_draft_status");
      expect(tool, app).toBeDefined();
      expect((tool!._meta as Record<string, any>).ui.visibility, app).toEqual(["app"]);
      expect((tool!._meta as Record<string, any>)["openai/visibility"], app).toBe("private");
      expect(tool!.annotations?.readOnlyHint, app).toBe(true);
    }
  });

  it("offers the checkouts to ChatGPT and not to Claude (#475)", async () => {
    const names = async (app: keyof typeof APPS) => {
      const { client } = await connect(app);
      return (await client.listTools()).tools.map((tool) => tool.name);
    };
    const checkouts = ["create_pack_checkout", "create_mail_checkout"];
    expect(await names("chatgpt")).toEqual(expect.arrayContaining(checkouts));
    const claude = await names("claude");
    for (const checkout of checkouts) {
      expect(claude).not.toContain(checkout);
    }
    expect(claude).toContain("list_letter_packs");
  });

  it("offers Letter IRL's image generation to ChatGPT and not to Claude (#467)", async () => {
    const names = async (app: keyof typeof APPS) => {
      const { client } = await connect(app);
      return (await client.listTools()).tools.map((tool) => tool.name);
    };
    expect(await names("chatgpt")).toContain("generate_image_for_mail");
    expect(await names("claude")).not.toContain("generate_image_for_mail");
  });

  it("describes the tools in each app's words", async () => {
    const described = async (app: keyof typeof APPS) => {
      const { client } = await connect(app);
      const { tools } = await client.listTools();
      return new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));
    };
    const chatgpt = await described("chatgpt");
    const claude = await described("claude");

    expect(chatgpt.get("get_account_balance")).toContain("without leaving the conversation");
    expect(claude.get("get_account_balance")).toContain("bought on the Letter IRL website");
    expect(chatgpt.get("generate_image_for_mail")).toContain("ChatGPT's built-in image generation");
    for (const [name, description] of claude) {
      expect(description, name).not.toMatch(/ChatGPT|without leaving the conversation/);
    }
  });

  it("writes a tool result for the app that called", async () => {
    const chatgpt = await connect("chatgpt");
    const fromChatgpt = await chatgpt.client.callTool({ name: "get_started", arguments: {} });
    expect(chatgpt.execute).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "get_started", client: clientProfileNamed("chatgpt") })
    );
    const chatgptText = (fromChatgpt.content as Array<{ text: string }>)[0].text;
    expect(chatgptText).toContain("getting-started card is displayed above");

    // Claude shows the card too (#474), which carries the letter packs link.
    const claude = await connect("claude");
    const fromClaude = await claude.client.callTool({ name: "get_started", arguments: {} });
    expect(claude.execute).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "get_started", client: clientProfileNamed("claude") })
    );
    expect((fromClaude.content as Array<{ text: string }>)[0].text).toBe(chatgptText);
    expect(fromClaude.structuredContent).toMatchObject({
      purchaseStep: expect.stringContaining("https://website.example/dashboard/letter-packs")
    });

    // An app with no card gets the guide as text.
    const vscode = await connect("vscode");
    const fromVscode = await vscode.client.callTool({ name: "get_started", arguments: {} });
    const vscodeText = (fromVscode.content as Array<{ text: string }>)[0].text;
    expect(vscodeText).toContain("https://website.example/dashboard/letter-packs");
    expect(vscodeText).toContain("Things to try:");
    expect(vscodeText).not.toMatch(/\bcard\b|right here/);
  });

  it("says beside a letter preview where the card shows that its words may change unseen (STUDIO-01, r54)", async () => {
    // Claude's model never sees what the card shares (HOME-02), so the preview's own text says it. The editor is on the
    // studio card's Words tab.
    vi.stubEnv("LETTER_IRL_STUDIO_CARD_ENABLED", "true");
    const preview = {
      draftId: "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0",
      lettersRequired: 1,
      canSendNow: true,
      layoutType: "text_only",
      wordsVersion: "w-1a2b3c",
      stationery: { theme: "classic", source: "default" },
      draftExpiresAt: "2026-10-19T18:00:00.000Z",
      sendEligibility: {
        payAndSend: { available: false },
        letterPack: { available: true, purchaseUrl: "https://website.example/dashboard/letter-packs" }
      }
    };
    const said = /change the words on the card[^]*call set_letter_words[^]*\(w-1a2b3c for this preview's\)/;
    for (const app of ["chatgpt", "claude", "vscode"] as const) {
      const { client } = await connect(app, preview);
      const answer = await client.callTool({
        name: "quote_and_preview_letter",
        arguments: {
          recipient: { name: "Ruth Example", addressLine1: "112 N 6th St", city: "Springfield", state: "IL", postalCode: "62701", country: "US" },
          bodyText: "Dear Ruth, thank you.",
          signOff: "Dee"
        }
      });
      const text = (answer.content as Array<{ text: string }>)[0].text;
      if (app === "vscode") expect(text, app).not.toMatch(/set_letter_words/);
      else expect(text, app).toMatch(said);
    }
  });
});

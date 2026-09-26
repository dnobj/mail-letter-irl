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
  claude: "https://claude.ai/oauth/mcp-oauth-client-metadata"
} as const;

async function connect(app: keyof typeof APPS) {
  vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
  vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid email offline_access mail:read mail:draft mail:send");
  vi.stubEnv("LETTER_IRL_WEBSITE_BASE_URL", "https://website.example");
  const real = new LetterIrlServer();
  // The real get_started, run with the app the call arrived with.
  const execute = vi.fn(async (request: { toolName: string; client?: ClientProfile }) => ({
    result: await getStartedTool.handler({}, { client: request.client } as never),
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

    const claude = await connect("claude");
    const fromClaude = await claude.client.callTool({ name: "get_started", arguments: {} });
    expect(claude.execute).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "get_started", client: clientProfileNamed("claude") })
    );
    const claudeText = (fromClaude.content as Array<{ text: string }>)[0].text;
    expect(claudeText).toContain("https://website.example/dashboard/letter-packs");
    expect(claudeText).toContain("Things to try:");
    expect(claudeText).not.toMatch(/\bcard\b|right here/);
  });
});

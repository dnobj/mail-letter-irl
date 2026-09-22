/**
 * get_profile on the wire (#424).
 *
 * The handler tests check the tool object; the contract tests check the
 * summary and the runtime schema. Neither shows what an MCP client actually
 * receives, and that is what ChatGPT validates: the `openai/profile` marker in
 * tools/list, an output schema that requires `id`, the id in
 * structuredContent on a call, and - when the account is refused - an error
 * result with no profile at all rather than a placeholder. This drives the
 * real McpServer and Client over an in-memory transport, with the app server
 * and the account preparation stubbed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/identity.js", () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue("person@example.com")
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prepareAuthenticatedUser } from "../../../src/auth/identity.js";
import { VerifiedEmailRequiredError } from "../../../src/auth/verifiedEmail.js";
import { registerLetterTools } from "../../../src/mcp/registerTools.js";
import { LetterIrlServer } from "../../../src/server.js";
import { getProfileTool } from "../../../src/tools/getProfile.js";

const authInfo = {
  userId: "auth0|test",
  claims: {},
  token: "token",
  authType: "jwt" as const,
  scopes: ["mail:read", "mail:draft", "mail:send"]
};

async function connectedClient(execute: (...args: unknown[]) => Promise<unknown>) {
  vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
  vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid email offline_access mail:read mail:draft mail:send");
  const server = new McpServer({ name: "profile-wire-test", version: "0.0.0" });
  await registerLetterTools(
    server,
    { listTools: () => [getProfileTool], execute: vi.fn(execute) } as any,
    authInfo
  );
  const client = new Client({ name: "profile-wire-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("get_profile on the wire", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is the only tool in the real registry that carries the marker", () => {
    // The one-tool stub below cannot see a second tool marked by mistake;
    // ChatGPT would have two candidates and no rule for choosing.
    const marked = new LetterIrlServer()
      .listTools()
      .filter((tool) => tool.meta["openai/profile"] === true)
      .map((tool) => tool.name);
    expect(marked).toEqual(["get_profile"]);
  });

  it("is listed with the openai/profile marker, an empty input, and an output that requires id", async () => {
    const client = await connectedClient(async () => ({ result: { id: "auth0|test" }, meta: {} }));
    const { tools } = await client.listTools();

    const marked = tools.filter((tool) => (tool._meta as Record<string, unknown> | undefined)?.["openai/profile"] === true);
    expect(marked.map((tool) => tool.name)).toEqual(["get_profile"]);

    const profile = marked[0];
    expect(profile.inputSchema.required ?? []).toEqual([]);
    expect((profile.outputSchema as { required?: string[] } | undefined)?.required).toContain("id");
    expect(profile.annotations?.readOnlyHint).toBe(true);
  });

  it("delivers the account row key in structuredContent, and only the address to the model", async () => {
    const client = await connectedClient(async () => ({
      result: { id: "auth0|test", email: "person@example.com" },
      meta: {}
    }));

    const result = await client.callTool({ name: "get_profile", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: "auth0|test", email: "person@example.com" });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("Account: person@example.com");
    expect(text).not.toContain("auth0|test");
  });

  it("returns an error result with no profile when the account is refused", async () => {
    // The wrapper refuses before any tool runs. ChatGPT must see a refusal,
    // not a placeholder: "return the appropriate auth error instead of a
    // placeholder ID or another account's profile".
    vi.mocked(prepareAuthenticatedUser).mockRejectedValueOnce(new VerifiedEmailRequiredError());
    const execute = vi.fn(async () => ({ result: { id: "auth0|test" }, meta: {} }));
    const client = await connectedClient(execute);

    const result = await client.callTool({ name: "get_profile", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/confirmed email address/);
    expect(execute).not.toHaveBeenCalled();
  });
});

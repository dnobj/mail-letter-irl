import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/identity.js", () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue(undefined)
}));

import { registerLetterTools } from "../../../src/mcp/registerTools.js";

describe("tool insufficient-scope challenge flow", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns an MCP OAuth challenge before invoking the tool handler", async () => {
    vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
    vi.stubEnv("LETTER_IRL_PUBLIC_BASE_URL", "https://dev-api.example.com");
    vi.stubEnv(
      "LETTER_IRL_OAUTH_SCOPES",
      "openid profile email mail:read mail:draft mail:send"
    );

    let callback:
      | ((args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<any>)
      | undefined;
    const mcpServer = {
      registerResource: vi.fn(),
      registerTool: vi.fn(
        (
          _name: string,
          _definition: unknown,
          handler: typeof callback
        ) => {
          callback = handler;
        }
      )
    };
    const appServer = {
      listTools: () => [
        {
          name: "send_letter",
          description: "Send a letter",
          readOnly: false,
          meta: {}
        }
      ],
      execute: vi.fn()
    };
    const authInfo = {
      userId: "auth0|test",
      claims: {},
      token: "token",
      authType: "jwt" as const,
      scopes: ["mail:read"]
    };

    await registerLetterTools(mcpServer as any, appServer as any, authInfo);
    expect(callback).toBeDefined();

    const result = await callback!({}, {});

    expect(appServer.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "Additional authorization is required for this action."
        }
      ],
      _meta: {
        "mcp/www_authenticate": [
          expect.stringContaining('error="insufficient_scope"')
        ]
      }
    });
    expect(result._meta["mcp/www_authenticate"][0]).toContain(
      'resource_metadata="https://dev-api.example.com/.well-known/oauth-protected-resource"'
    );
    expect(result._meta["mcp/www_authenticate"][0]).toContain(
      'scope="mail:send"'
    );
  });
});

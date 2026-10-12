import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/identity.js", () => ({
  prepareAuthenticatedUser: vi.fn().mockResolvedValue(undefined)
}));

import { registerLetterTools } from "../../../src/mcp/registerTools.js";
import {
  authorizeTool,
  PERSONAL_TOKEN_REFUSAL,
  PERSONAL_TOKEN_REFUSED_TOOLS,
  PersonalTokenRefusedError
} from "../../../src/auth/toolScopes.js";
import { findRestRoute, REST_ROUTE_SCOPES } from "../../../src/auth/restScopes.js";
import type { AuthenticatedUser } from "../../../src/auth/tokenValidator.js";
import * as diagnostics from "../../../src/utils/diagnosticLog.js";

/**
 * A personal access token cannot cancel scheduled mail, or replace or remove what the person saved (#685, decision
 * D5), whatever its scopes. An app signed in with OAuth keeps those tools. These drive the real registration wrapper;
 * only the tool layer is faked.
 */

const REFUSED = [
  "cancel_scheduled_mail",
  "set_signature",
  "clear_signature",
  "delete_stationery_design",
  "cancel_address_request"
];
// Their neighbours, which a token keeps: saving and reading, and the return address's own clear.
const KEPT = ["get_signature", "save_stationery_design", "list_stationery_designs", "request_address", "clear_return_address"];
const TOOLS = [...REFUSED, ...KEPT].map(name => ({ name, description: name, readOnly: false, meta: {} }));

// Every product scope: the refusal holds whatever the token was given.
const pat: AuthenticatedUser = {
  userId: "auth0|user",
  claims: {},
  token: "t",
  authType: "pat",
  scopes: ["mail:read", "mail:draft", "mail:send"]
};
const oauth: AuthenticatedUser = {
  userId: "auth0|user",
  claims: { azp: "https://claude.ai/oauth/mcp-oauth-client-metadata" },
  token: "t",
  authType: "jwt",
  scopes: ["mail:read", "mail:draft", "mail:send"]
};

type Callback = (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<any>;

async function register(authInfo: AuthenticatedUser) {
  vi.stubEnv("LETTER_IRL_REQUIRE_AUTH", "true");
  vi.stubEnv("LETTER_IRL_OAUTH_SCOPES", "openid profile email mail:read mail:draft mail:send");
  const callbacks = new Map<string, Callback>();
  const mcpServer = {
    registerResource: vi.fn(),
    registerTool: vi.fn((name: string, _definition: unknown, handler: Callback) => {
      callbacks.set(name, handler);
    })
  };
  const execute = vi.fn(async () => ({ result: { message: "done" }, meta: {} }));
  await registerLetterTools(mcpServer as any, { listTools: () => TOOLS, execute } as any, authInfo);
  return { callbacks, execute };
}

describe("personal access tokens and the tools that cannot be undone (#685)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    writeSpy = vi.spyOn(diagnostics, "writeDiagnostic").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    writeSpy.mockRestore();
  });

  it("lists exactly these tools", () => {
    expect([...PERSONAL_TOKEN_REFUSED_TOOLS].sort()).toEqual([...REFUSED].sort());
  });

  it.each(REFUSED)("refuses %s to a personal access token, before the tool, saying what to do instead", async name => {
    const { callbacks, execute } = await register(pat);
    const result = await callbacks.get(name)!({ orderId: "o", requestId: "r", designId: "d", confirm: true }, {});
    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: PERSONAL_TOKEN_REFUSAL }] });
    expect(writeSpy).toHaveBeenCalledWith("info", "auth.pat_tool_refused", { toolName: name });
  });

  it.each(REFUSED)("leaves %s to an app signed in with OAuth", async name => {
    const { callbacks, execute } = await register(oauth);
    const result = await callbacks.get(name)!({ orderId: "o", requestId: "r", designId: "d", confirm: true }, {});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ toolName: name }));
    expect(result.isError).toBeUndefined();
  });

  it.each(KEPT)("leaves %s to a personal access token", async name => {
    const { callbacks, execute } = await register(pat);
    await callbacks.get(name)!({}, {});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ toolName: name }));
  });

  it("refuses in authorizeTool itself, after the scopes", () => {
    for (const name of REFUSED) {
      expect(() => authorizeTool(name, pat, true)).toThrow(PersonalTokenRefusedError);
      expect(() => authorizeTool(name, oauth, true)).not.toThrow();
    }
  });

  it("names the website and a signed-in app as where to do it", () => {
    expect(PERSONAL_TOKEN_REFUSAL).toMatch(/Letter IRL website/);
    expect(PERSONAL_TOKEN_REFUSAL).toMatch(/signed in/);
  });
});

describe("the REST twins of those tools (#685)", () => {
  it("each refused tool's REST twin, where it has one, is a route the website's JWT alone reaches", async () => {
    const twins = REST_ROUTE_SCOPES.filter(route => route.twin && PERSONAL_TOKEN_REFUSED_TOOLS.has(route.twin));
    expect(twins.map(route => route.id).sort()).toEqual(["letters.cancel", "signature.clear", "signature.set"]);
    expect(findRestRoute("POST", "/api/letters/ltr_1/cancel")?.twin).toBe("cancel_scheduled_mail");
  });
});

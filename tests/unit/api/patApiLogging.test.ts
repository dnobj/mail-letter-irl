import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/auth/tokenValidator.js", () => ({
  validateAuthorizationHeader: vi.fn().mockResolvedValue({
    userId: "auth0|private-subject",
    authType: "jwt",
    scopes: [],
    claims: {},
    token: "private-bearer-token"
  })
}));

vi.mock("../../../src/services/patService.js", () => ({
  createToken: vi.fn(),
  listTokens: vi.fn(),
  revokeToken: vi.fn()
}));

import { listTokens } from "../../../src/services/patService.js";
import { handlePATApiRequest } from "../../../src/api/patApiHandler.js";

describe("PAT API diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps exception details and tokens out of logs and the response", async () => {
    const sensitive = "private exception private-bearer-token auth0|private-subject";
    vi.mocked(listTokens).mockRejectedValue(new Error(sensitive));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = Object.assign(new EventEmitter(), {
      method: "GET",
      headers: { authorization: "Bearer private-bearer-token" }
    });
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn()
    };

    expect(await handlePATApiRequest(req as never, response as never, "/api/tokens")).toBe(true);

    const logged = error.mock.calls.flat().map(String).join("\n");
    const body = String(response.end.mock.calls[0][0]);
    expect(logged).toContain('"event":"auth.pat_api_failed"');
    expect(logged).toContain('"errorClass":"database_error"');
    expect(body).toContain("Unable to complete token request");
    expect(body).not.toContain(sensitive);
    expect(logged).not.toContain(sensitive);
    expect(logged).not.toContain("private-bearer-token");
  });
});

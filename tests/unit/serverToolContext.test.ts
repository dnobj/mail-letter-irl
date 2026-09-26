/**
 * The calling app reaches the tool (#484).
 *
 * registerTools passes the app with every call, and LetterIrlServer.execute
 * has to put it in the tool's context, or every handler answers as an app
 * that trusts nothing. The wire test (tests/unit/mcp/toolTextWire.test.ts)
 * stubs execute, so this runs the real one, with only the account store
 * stubbed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/store/fileAccountStore.js", () => ({
  FileAccountStore: class {
    async getOrCreate(userId: string) {
      return { userId, creditsRemaining: 0, orders: [] };
    }
    async persist() {}
  }
}));

import { LetterIrlServer } from "../../src/server.js";
import { clientProfileNamed, type ClientProfileName } from "../../src/auth/clientProfiles.js";

describe("LetterIrlServer.execute", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("hands the calling app to the tool", async () => {
    vi.stubEnv("LETTER_IRL_WEBSITE_BASE_URL", "https://website.example");
    const server = new LetterIrlServer();
    const purchaseStep = async (app: ClientProfileName) =>
      (
        await server.execute<Record<string, never>, { purchaseStep: string }>({
          toolName: "get_started",
          input: {},
          userId: "auth0|test",
          client: clientProfileNamed(app)
        })
      ).result.purchaseStep;

    expect(await purchaseStep("chatgpt")).toContain("right here");
    expect(await purchaseStep("claude")).toContain("https://website.example/dashboard/letter-packs");
  });
});

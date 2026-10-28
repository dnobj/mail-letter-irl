import { afterEach, describe, expect, it, vi } from "vitest";
import { widgetTemplateUri } from "../../../src/mcp/widgetUris.js";
import { getStartedTool } from "../../../src/tools/getStarted.js";
import { clientProfileNamed } from "../../../src/auth/clientProfiles.js";
import { describeTool } from "../../../src/server.js";

const inApp = (name: Parameters<typeof clientProfileNamed>[0]) =>
  ({ client: clientProfileNamed(name) }) as never;

describe("get_started tool", () => {
  it("should be read-only", () => {
    expect(getStartedTool.readOnly).toBe(true);
  });

  it("should render the onboarding widget", () => {
    expect(getStartedTool.meta["openai/outputTemplate"]).toBe(
      widgetTemplateUri("GetStartedCard")
    );
  });

  it("has a short title", () => {
    expect(getStartedTool.title).toBe("Get started");
  });

  it("should return onboarding guidance", async () => {
    const result = await getStartedTool.handler({}, inApp("chatgpt"));

    expect(result.title).toContain("Get Started");
    // Was "letterirl.com". Packs sell in the conversation since #312, and
    // that variable is unset in both environments, so the guidance now points
    // here rather than away.
    expect(result.purchaseStep).toMatch(/right here/);
    expect(result.purchaseStep).not.toContain("letterirl.com");
    expect(result.examplePrompts.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * An app that takes no purchases (#484). Claude does not allow purchases
 * through connectors (#475), yet this guide told Claude's model that letters
 * could be bought without leaving the conversation, and it offered to set up
 * a pack purchase.
 */
describe("get_started in an app that takes no purchases", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends the person to the dashboard's letter packs page", async () => {
    vi.stubEnv("LETTER_IRL_WEBSITE_BASE_URL", "https://website.example/");
    for (const name of ["claude", "claude_code", "codex", "vscode", "hermes", "token", "generic"] as const) {
      const { purchaseStep } = await getStartedTool.handler({}, inApp(name));
      expect(purchaseStep, name).toContain("https://website.example/dashboard/letter-packs");
      expect(purchaseStep, name).not.toMatch(/right here|pay for a single|in the conversation/);
    }
  });

  it("does so whether or not Pay & Send is on, since both routes are checkouts", async () => {
    for (const flag of ["true", "false"]) {
      vi.stubEnv("JIT_PURCHASE_ENABLED", flag);
      const { purchaseStep } = await getStartedTool.handler({}, inApp("claude"));
      expect(purchaseStep, flag).toMatch(/^Letters are prepaid: buy a letter pack on your Letter IRL dashboard at /);
    }
  });

  it("gives a context that names no app the same answer", async () => {
    const unnamed = await getStartedTool.handler({}, {} as never);
    const generic = await getStartedTool.handler({}, inApp("generic"));
    expect(unnamed.purchaseStep).toBe(generic.purchaseStep);
  });

  it("describes itself without promising a purchase in the conversation", () => {
    expect(describeTool(getStartedTool, clientProfileNamed("chatgpt"))).toContain(
      "without leaving the conversation"
    );
    const elsewhere = describeTool(getStartedTool, clientProfileNamed("claude"));
    expect(elsewhere).toContain("how to buy prepaid letters");
    expect(elsewhere).not.toMatch(/without leaving the conversation|right here/);
  });
});

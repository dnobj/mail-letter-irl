import { afterEach, describe, expect, it, vi } from "vitest";
import { DIYProvider } from "../../../src/services/providers/DIYProvider.js";
import { DummyProvider } from "../../../src/services/providers/DummyProvider.js";
import { PostGridProvider } from "../../../src/services/providers/PostGridProvider.js";

const recipient = "Highly Private Recipient";
const providerBody = "private provider body with 123 Secret Street";
const params = {
  idempotencyKey: "private-idempotency-key",
  recipientName: recipient,
  recipientAddress: { line1: "123 Secret Street", city: "Secret City", state: "IL", postalCode: "60601" },
  senderName: "Private Sender",
  senderAddress: { line1: "1 Sender St", city: "Chicago", state: "IL", postalCode: "60602" },
  message: "private letter content",
  metadata: { letterId: "private-letter-id" }
} as const;

function output(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join("\n");
}

describe("provider runtime logging privacy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("omits recipient and letter identifiers from DIY and dummy logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await new DIYProvider({ name: "diy", displayName: "DIY", enabled: true, config: { verbose: true } })
      .sendLetter(params);
    await new DummyProvider(
      { name: "dummy", displayName: "Dummy", enabled: true },
      { verbose: true, delayMs: 0, failureRate: 0 }
    ).sendLetter(params);

    const logged = output(log);
    expect(logged).toContain("Queuing letter for manual fulfillment");
    expect(logged).toContain("Sending letter");
    for (const sensitive of [recipient, "private-letter-id", "123 Secret Street", "private letter content"]) {
      expect(logged).not.toContain(sensitive);
    }
  });

  it("omits recipient and arbitrary provider response bodies from PostGrid logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: providerBody }
    }), { status: 400, headers: { "Content-Type": "application/json" } })));
    const provider = new PostGridProvider(
      { name: "postgrid", displayName: "PostGrid", enabled: true },
      { apiKey: "test-key", verbose: true, timeoutMs: 100 }
    );

    await provider.sendLetter(params);

    const logged = output(log);
    expect(logged).toContain("Letter send failed");
    for (const sensitive of [recipient, providerBody, "123 Secret Street", "private letter content"]) {
      expect(logged).not.toContain(sensitive);
    }
  });
});

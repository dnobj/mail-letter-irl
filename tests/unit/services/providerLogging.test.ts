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
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: providerBody }
    }), { status: 400, headers: { "Content-Type": "application/json" } })));
    const provider = new PostGridProvider(
      { name: "postgrid", displayName: "PostGrid", enabled: true },
      { apiKey: "test-key", verbose: true, timeoutMs: 100 }
    );

    await provider.sendLetter(params);

    const logged = `${output(log)}\n${output(error)}`;
    expect(logged).toContain('"event":"provider.postgrid.operation_failed"');
    expect(logged).toContain('"operation":"create_letter"');
    for (const sensitive of [recipient, providerBody, "123 Secret Street", "private letter content"]) {
      expect(logged).not.toContain(sensitive);
    }
  });

  it("uses a stable status operation without logging URL or provider identifiers", async () => {
    const trackingId = "letter_private-tracking-id";
    const providerId = "provider-private-id";
    const baseUrl = "https://private-provider.example/tenant-secret";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: providerId,
      object: "letter",
      live: false,
      status: "delivered",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      expectedDeliveryDate: "2026-07-02T00:00:00.000Z",
      url: `${baseUrl}/letters/${providerId}`,
      trackingUrl: `https://tracking.example/${providerId}`
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const provider = new PostGridProvider(
      { name: "postgrid", displayName: "PostGrid", enabled: true },
      { apiKey: "test-key", baseUrl, verbose: true, timeoutMs: 100 }
    );

    await expect(provider.getStatus(trackingId)).resolves.toMatchObject({
      trackingId,
      status: "delivered"
    });

    const logged = output(log);
    expect(logged).toContain('"event":"provider.postgrid.request_dispatched"');
    expect(logged).toContain('"operation":"get_letter_status"');
    expect(logged).not.toContain(trackingId);
    expect(logged).not.toContain(providerId);
    expect(logged).not.toContain(baseUrl);
    expect(logged).not.toContain("/letters/");
  });

  it("logs safe verification classifications without address or endpoint data", async () => {
    const baseUrl = "https://private-provider.example/tenant-secret";
    const providerId = "verification-private-id";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: providerId,
      status: "success",
      message: "private provider message",
      data: {
        status: "corrected",
        line1: "456 Corrected Secret Street",
        city: "Secret City",
        provinceOrState: "IL",
        postalOrZip: "60601",
        country: "US"
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const provider = new PostGridProvider(
      { name: "postgrid", displayName: "PostGrid", enabled: true },
      { apiKey: "test-key", baseUrl, verbose: true, timeoutMs: 100 }
    );

    await expect(provider.validateAddress({
      line1: "123 Original Secret Street",
      city: "Secret City",
      state: "IL",
      postalCode: "60601",
      country: "US"
    })).resolves.toMatchObject({ status: "corrected", isValid: true });

    const logged = output(log);
    expect(logged).toContain('"event":"provider.postgrid.request_dispatched"');
    expect(logged).toContain('"operation":"verify_domestic_address"');
    expect(logged).toContain('"providerStatus":"corrected"');
    for (const sensitive of [
      baseUrl,
      providerId,
      "private provider message",
      "123 Original Secret Street",
      "456 Corrected Secret Street",
      "/verifications",
      "api.postgrid.com"
    ]) {
      expect(logged).not.toContain(sensitive);
    }
  });
});

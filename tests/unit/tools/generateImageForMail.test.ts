import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hybrid image tool (issue #227; decision record Addendum 3): generates
 * in-turn against the user's Letter IRL image credits, degrades to a
 * copy-the-prompt redirect card otherwise, and never hard-fails the model.
 */

vi.mock("../../../src/services/imageGenerationService.js", () => ({
  generateImage: vi.fn(),
  ImageGenerationError: class ImageGenerationError extends Error {
    code = "PROVIDER_ERROR";
    outcome: "definite" | "ambiguous" = "definite";
    userMessage = "boom";
    providerRequestId?: string;
  }
}));

vi.mock("../../../src/services/imageGenerationLimitService.js", () => ({
  reserveGeneration: vi.fn(),
  markGenerationDispatched: vi.fn(),
  commitGenerationReservation: vi.fn(),
  releaseGenerationReservation: vi.fn(),
  markGenerationReservationAmbiguous: vi.fn(),
  ensureStarterGrant: vi.fn(),
  countGenerationsToday: vi.fn()
}));

vi.mock("../../../src/services/tempImageStore.js", () => ({
  storeImage: vi.fn()
}));

import { generateImageForMailTool } from "../../../src/tools/generateImageForMail.js";
import { widgetTemplateUri } from "../../../src/mcp/widgetUris.js";
import * as genService from "../../../src/services/imageGenerationService.js";
import * as limitService from "../../../src/services/imageGenerationLimitService.js";
import * as tempStore from "../../../src/services/tempImageStore.js";

const context = {
  user: { userId: "user-1" },
  correlationId: "test",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
} as never;

// 1x1 JPEG so sharp can build a real preview in the generated-mode test.
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.LETTER_IRL_IMAGE_DAILY_CEILING = "200";
  vi.mocked(limitService.ensureStarterGrant).mockResolvedValue(undefined);
  vi.mocked(limitService.countGenerationsToday).mockResolvedValue(0);
});

describe("generate_image_for_mail (hybrid)", () => {
  it("declares the hybrid contract honestly", () => {
    expect(generateImageForMailTool.name).toBe("generate_image_for_mail");
    expect(generateImageForMailTool.readOnly).toBe(false);
    expect(generateImageForMailTool.meta["openai/outputTemplate"]).toBe(
      widgetTemplateUri("ImageRoutingCard")
    );
    expect(generateImageForMailTool.description).toContain("Letter IRL image credits");
    expect(generateImageForMailTool.description).toContain("built-in image generation");
  });

  it("generates in-turn when a credit reserves, and chains to the preview tool", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: true,
      reservationId: "res-1",
      remaining: 2,
      used: 1,
      allowance: 3
    } as never);
    vi.mocked(limitService.markGenerationDispatched).mockResolvedValue(true as never);
    vi.mocked(limitService.commitGenerationReservation).mockResolvedValue(true as never);
    vi.mocked(genService.generateImage).mockImplementation(async (_prompt, opts) => {
      await (opts as { beforeDispatch: () => Promise<void> }).beforeDispatch();
      return { base64Data: TINY_JPEG_BASE64, providerRequestId: "prov-1" } as never;
    });
    vi.mocked(tempStore.storeImage).mockResolvedValue("token-1" as never);

    const result = await generateImageForMailTool.handler(
      { prompt: "a walrus playing saxophone", context: "postcard" },
      context
    );

    expect(result.mode).toBe("generated");
    expect(result.generatedImageUrl).toContain("/api/temp-image/token-1");
    expect(result.generationsRemaining).toBe(2);
    expect(result.suggestedNextStep).toContain("quote_and_preview_postcard");
    expect(result.generatedImagePreview).toBeTruthy();
    expect(limitService.commitGenerationReservation).toHaveBeenCalledWith("res-1", "prov-1");
    expect(limitService.ensureStarterGrant).toHaveBeenCalledWith("user-1");
  });

  it("redirects with the copy-ready prompt when no credits remain", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: false,
      remaining: 0,
      used: 3,
      allowance: 3
    } as never);

    const result = await generateImageForMailTool.handler(
      { prompt: "a walrus playing saxophone" },
      context
    );

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("no_credits");
    expect(result.prompt).toBe("a walrus playing saxophone");
    expect(result.suggestedNextStep).toContain("WITHOUT mentioning Letter IRL");
    expect(genService.generateImage).not.toHaveBeenCalled();
  });

  it("redirects when the global daily ceiling is reached", async () => {
    vi.mocked(limitService.countGenerationsToday).mockResolvedValue(200);

    const result = await generateImageForMailTool.handler(
      { prompt: "anything" },
      context
    );

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("daily_ceiling_reached");
    expect(limitService.reserveGeneration).not.toHaveBeenCalled();
  });

  it("redirects when generation is unconfigured", async () => {
    delete process.env.OPENAI_API_KEY;

    const result = await generateImageForMailTool.handler(
      { prompt: "anything" },
      context
    );

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("generation_unconfigured");
    expect(limitService.ensureStarterGrant).not.toHaveBeenCalled();
  });

  it("releases the reservation and redirects on a definite pre-dispatch failure", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: true,
      reservationId: "res-2",
      remaining: 1,
      used: 2,
      allowance: 3
    } as never);
    vi.mocked(genService.generateImage).mockRejectedValue(new Error("network down"));

    const result = await generateImageForMailTool.handler(
      { prompt: "a walrus" },
      context
    );

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("generation_failed");
    expect(limitService.releaseGenerationReservation).toHaveBeenCalledWith(
      "user-1",
      "res-2",
      "pre_dispatch_failure"
    );
    expect(limitService.markGenerationReservationAmbiguous).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous reservation when the provider outcome is unknown", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: true,
      reservationId: "res-3",
      remaining: 1,
      used: 2,
      allowance: 3
    } as never);
    vi.mocked(limitService.markGenerationDispatched).mockResolvedValue(true as never);
    vi.mocked(genService.generateImage).mockImplementation(async (_prompt, opts) => {
      await (opts as { beforeDispatch: () => Promise<void> }).beforeDispatch();
      throw new Error("socket hang up mid-flight");
    });

    const result = await generateImageForMailTool.handler(
      { prompt: "a walrus" },
      context
    );

    expect(result.mode).toBe("redirect");
    expect(limitService.markGenerationReservationAmbiguous).toHaveBeenCalled();
    expect(limitService.releaseGenerationReservation).not.toHaveBeenCalled();
  });

  it("redirects politely when no prompt was provided", async () => {
    const result = await generateImageForMailTool.handler({}, context);
    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("no_prompt");
  });
});

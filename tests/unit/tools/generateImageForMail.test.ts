import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hybrid image tool (issue #227; decision record Addendum 3): generates
 * in-turn against the user's Letter IRL image generations, degrades to a
 * copy-the-prompt redirect card otherwise, and never hard-fails the model.
 */

vi.mock("../../../src/services/imageGenerationService.js", () => ({
  generateImage: vi.fn(),
  ImageGenerationError: class ImageGenerationError extends Error {
    code = "PROVIDER_ERROR";
    // Must mirror the real union exactly (imageGenerationService.ts):
    outcome: "definite_failure" | "ambiguous" = "definite_failure";
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
  storeImage: vi.fn(),
  isTempImageStoreConfigured: vi.fn()
}));

import { generateImageForMailTool } from "../../../src/tools/generateImageForMail.js";
import { widgetTemplateUri } from "../../../src/mcp/widgetUris.js";
import * as genService from "../../../src/services/imageGenerationService.js";
import * as limitService from "../../../src/services/imageGenerationLimitService.js";
import * as tempStore from "../../../src/services/tempImageStore.js";
const tempStoreModule = tempStore;

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
  process.env.LETTER_IRL_IMAGE_GEN_MODE = "on";
  vi.mocked(limitService.ensureStarterGrant).mockResolvedValue(undefined);
  vi.mocked(limitService.countGenerationsToday).mockResolvedValue(0);
  vi.mocked(tempStore.isTempImageStoreConfigured).mockReturnValue(true as never);
});

describe("generate_image_for_mail (hybrid)", () => {
  it("declares the hybrid contract honestly", () => {
    expect(generateImageForMailTool.name).toBe("generate_image_for_mail");
    expect(generateImageForMailTool.readOnly).toBe(false);
    expect(generateImageForMailTool.meta["openai/outputTemplate"]).toBe(
      widgetTemplateUri("ImageRoutingCard")
    );
    expect(generateImageForMailTool.description).toContain("Letter IRL image generations");
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

  it("marks ambiguous when the commit fails AFTER provider success (billable)", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: true,
      reservationId: "res-4",
      remaining: 1,
      used: 2,
      allowance: 3
    } as never);
    vi.mocked(limitService.markGenerationDispatched).mockResolvedValue(true as never);
    vi.mocked(limitService.commitGenerationReservation).mockResolvedValue(false as never);
    vi.mocked(genService.generateImage).mockImplementation(async (_prompt, opts) => {
      await (opts as { beforeDispatch: () => Promise<void> }).beforeDispatch();
      return { base64Data: TINY_JPEG_BASE64, providerRequestId: "prov-4" } as never;
    });

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, context);

    expect(result.mode).toBe("redirect");
    // Provider succeeded, so the credit must be PRESERVED for reconciliation,
    // never released back as if unspent.
    expect(limitService.markGenerationReservationAmbiguous).toHaveBeenCalledWith(
      "user-1",
      "res-4",
      "provider_succeeded_persistence_unknown",
      "prov-4"
    );
    expect(limitService.releaseGenerationReservation).not.toHaveBeenCalled();
    // The honest copy branch: no "nothing was used" claim on an ambiguous
    // path. Matched against the CURRENT wording - checking for the old
    // "no credit was used" would now pass trivially, since that string exists
    // nowhere, and the guard would be unable to fail.
    expect(result.message).not.toContain("none of your generations were used");
  });

  it("releases on a post-dispatch DEFINITE provider failure", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: true,
      reservationId: "res-5",
      remaining: 1,
      used: 2,
      allowance: 3
    } as never);
    vi.mocked(limitService.markGenerationDispatched).mockResolvedValue(true as never);
    vi.mocked(genService.generateImage).mockImplementation(async (_prompt, opts) => {
      await (opts as { beforeDispatch: () => Promise<void> }).beforeDispatch();
      const err = new genService.ImageGenerationError("content policy");
      (err as { outcome: string }).outcome = "definite_failure";
      throw err;
    });

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, context);

    expect(result.mode).toBe("redirect");
    expect(limitService.releaseGenerationReservation).toHaveBeenCalledWith(
      "user-1",
      "res-5",
      "provider_definite_failure"
    );
    expect(limitService.markGenerationReservationAmbiguous).not.toHaveBeenCalled();
    expect(result.message).toContain("none of your generations were used");
  });

  it("marks ambiguous when the temp store throws after the credit is consumed", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: true,
      reservationId: "res-6",
      remaining: 1,
      used: 2,
      allowance: 3
    } as never);
    vi.mocked(limitService.markGenerationDispatched).mockResolvedValue(true as never);
    vi.mocked(limitService.commitGenerationReservation).mockResolvedValue(true as never);
    vi.mocked(genService.generateImage).mockImplementation(async (_prompt, opts) => {
      await (opts as { beforeDispatch: () => Promise<void> }).beforeDispatch();
      return { base64Data: TINY_JPEG_BASE64, providerRequestId: "prov-6" } as never;
    });
    vi.mocked(tempStore.storeImage).mockRejectedValue(new Error("bucket down"));

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, context);

    expect(result.mode).toBe("redirect");
    expect(limitService.markGenerationReservationAmbiguous).toHaveBeenCalled();
    expect(limitService.releaseGenerationReservation).not.toHaveBeenCalled();
  });

  it("redirects instead of hard-failing when the reservation itself rejects", async () => {
    vi.mocked(limitService.reserveGeneration).mockRejectedValue(new Error("pool exhausted"));

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, context);

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("generation_failed");
    expect(genService.generateImage).not.toHaveBeenCalled();
  });

  it("redirects with generation_unconfigured when the temp store is not configured", async () => {
    vi.mocked(tempStoreModule.isTempImageStoreConfigured).mockReturnValue(false as never);

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, context);

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("generation_unconfigured");
    expect(limitService.reserveGeneration).not.toHaveBeenCalled();
  });

  it("mode off: always redirects, grants nothing, spends nothing", async () => {
    process.env.LETTER_IRL_IMAGE_GEN_MODE = "off";

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, context);

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("generation_disabled");
    expect(result.redirectStyle).toBe("resend");
    expect(limitService.ensureStarterGrant).not.toHaveBeenCalled();
    expect(limitService.reserveGeneration).not.toHaveBeenCalled();
  });

  it("mode off on confirmed desktop: handoff redirect instructs in-turn built-in generation", async () => {
    process.env.LETTER_IRL_IMAGE_GEN_MODE = "off";
    const desktopContext = { ...context, isMobile: false } as never;

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, desktopContext);

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("generation_disabled");
    expect(result.redirectStyle).toBe("handoff");
    expect(result.suggestedNextStep).toContain("NOW in this same turn");
    expect(result.message).toContain("replying 'go ahead' is enough");
    expect(limitService.reserveGeneration).not.toHaveBeenCalled();
  });

  it("mode off on mobile: resend card (built-in generation absent from mention-scoped turns)", async () => {
    process.env.LETTER_IRL_IMAGE_GEN_MODE = "off";
    const mobileContext = { ...context, isMobile: true } as never;

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, mobileContext);

    expect(result.mode).toBe("redirect");
    expect(result.redirectStyle).toBe("resend");
    expect(result.suggestedNextStep).toContain("WITHOUT mentioning Letter IRL");
  });

  it("no_credits on confirmed desktop: handoff style applies beyond the mode gate", async () => {
    const desktopContext = { ...context, isMobile: false } as never;
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: false,
      remaining: 0,
      used: 3,
      allowance: 3
    } as never);

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, desktopContext);

    expect(result.status).toBe("no_credits");
    expect(result.redirectStyle).toBe("handoff");
    expect(result.suggestedNextStep).toContain("NOW in this same turn");
  });

  it("mode mobile_only: redirects on non-mobile surfaces (fails closed when unknown)", async () => {
    process.env.LETTER_IRL_IMAGE_GEN_MODE = "mobile_only";

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, context);

    expect(result.mode).toBe("redirect");
    expect(result.status).toBe("generation_mobile_only");
    expect(limitService.reserveGeneration).not.toHaveBeenCalled();
  });

  it("mode mobile_only: generates on mobile surfaces", async () => {
    process.env.LETTER_IRL_IMAGE_GEN_MODE = "mobile_only";
    const mobileContext = {
      user: { userId: "user-1" },
      correlationId: "test",
      isMobile: true,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    } as never;
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: true,
      reservationId: "res-7",
      remaining: 1,
      used: 2,
      allowance: 3
    } as never);
    vi.mocked(limitService.markGenerationDispatched).mockResolvedValue(true as never);
    vi.mocked(limitService.commitGenerationReservation).mockResolvedValue(true as never);
    vi.mocked(genService.generateImage).mockImplementation(async (_prompt, opts) => {
      await (opts as { beforeDispatch: () => Promise<void> }).beforeDispatch();
      return { base64Data: TINY_JPEG_BASE64, providerRequestId: "prov-7" } as never;
    });
    vi.mocked(tempStore.storeImage).mockResolvedValue("token-7" as never);

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, mobileContext);

    expect(result.mode).toBe("generated");
  });
});

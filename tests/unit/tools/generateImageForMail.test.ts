import { beforeEach, describe, expect, it, vi } from "vitest";
import { _testing as imageTesting } from "../../../src/services/imageService.js";

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
import { clientProfileNamed } from "../../../src/auth/clientProfiles.js";
import { describeTool } from "../../../src/server.js";
const tempStoreModule = tempStore;

// The redirect below routes to ChatGPT's own image generation, which only
// ChatGPT has (#484); the other apps' redirect has its own suite at the end.
const context = {
  user: { userId: "user-1" },
  correlationId: "test",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  client: clientProfileNamed("chatgpt")
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
    const description = describeTool(generateImageForMailTool, clientProfileNamed("chatgpt"));
    expect(description).toContain("Letter IRL image generations");
    expect(description).toContain("built-in image generation");
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
    // The preview is a real sharp decode of provider bytes: it runs under the
    // same decode gate as customer images.
    const decodeRun = vi.spyOn(imageTesting.decodeGate, "run");

    const result = await generateImageForMailTool.handler(
      { prompt: "a walrus playing saxophone", context: "postcard" },
      context
    );

    expect(result.mode).toBe("generated");
    expect(decodeRun).toHaveBeenCalledTimes(1);
    decodeRun.mockRestore();
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

/**
 * Outside ChatGPT (#484). Claude read "ChatGPT's built-in image generation
 * creates images free" in this tool's description, and the redirect told the
 * person to resend the prompt to a generator their app does not have. An app
 * with no image generation of its own gets the reason and one way on: an image
 * of their own. A context that names no app gets the same.
 */
describe("generate_image_for_mail in an app with no image generation of its own", () => {
  // VS Code: offered Letter IRL's generation, with none of its own. Claude is
  // not offered the tool at all (#467), so it never reaches these answers.
  const vscodeContext = {
    user: { userId: "user-1" },
    correlationId: "test",
    isMobile: false,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    client: clientProfileNamed("vscode")
  } as never;
  const unnamedContext = {
    user: { userId: "user-1" },
    correlationId: "test",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  } as never;

  function expectOwnImageRedirect(result: Record<string, unknown>, reason: string) {
    expect(result.mode).toBe("redirect");
    expect(result.message).toBe(`${reason} You can use an image of your own instead.`);
    // In an app with no card, this is all the model reads, so it leads with
    // the reason and names the one way on.
    expect((result.suggestedNextStep as string).startsWith(`${reason} `)).toBe(true);
    expect(result.suggestedNextStep).toContain("an image of their own");
    expect(result.suggestedNextStep).toContain("imageUrl");
    expect(result.redirectStyle).toBeUndefined();
    const text = `${result.message} ${result.suggestedNextStep}`;
    expect(text).not.toMatch(/ChatGPT|built-in|image_gen|WITHOUT mentioning|card above/);
  }

  it("describes itself without naming ChatGPT", () => {
    for (const name of ["claude", "claude_code", "codex", "vscode", "hermes", "token", "generic"] as const) {
      const description = describeTool(generateImageForMailTool, clientProfileNamed(name));
      expect(description, name).toContain("Letter IRL image generations");
      expect(description, name).toContain("an image of their own");
      expect(description, name).toContain("Never refuse an image request");
      expect(description, name).not.toMatch(/ChatGPT|built-in/);
    }
  });

  it("still generates while the account has generations left", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: true,
      reservationId: "res-9",
      remaining: 1,
      used: 2,
      allowance: 3
    } as never);
    vi.mocked(limitService.markGenerationDispatched).mockResolvedValue(true as never);
    vi.mocked(limitService.commitGenerationReservation).mockResolvedValue(true as never);
    vi.mocked(genService.generateImage).mockImplementation(async (_prompt, opts) => {
      await (opts as { beforeDispatch: () => Promise<void> }).beforeDispatch();
      return { base64Data: TINY_JPEG_BASE64, providerRequestId: "prov-9" } as never;
    });
    vi.mocked(tempStore.storeImage).mockResolvedValue("token-9" as never);

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, vscodeContext);

    expect(result.mode).toBe("generated");
  });

  it("asks for an image of their own when no generations remain", async () => {
    vi.mocked(limitService.reserveGeneration).mockResolvedValue({
      reserved: false,
      remaining: 0,
      used: 3,
      allowance: 3
    } as never);

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, vscodeContext);

    expect(result.status).toBe("no_credits");
    expect(result.prompt).toBe("a walrus");
    expectOwnImageRedirect(
      result as never,
      "This account has no Letter IRL image generations left. Letter packs and letter purchases include in-turn generations."
    );
  });

  it("says generation is off, rather than that ChatGPT has the request, when the mode is off", async () => {
    process.env.LETTER_IRL_IMAGE_GEN_MODE = "off";

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, vscodeContext);

    expect(result.status).toBe("generation_disabled");
    expectOwnImageRedirect(result as never, "Letter IRL is not making images here right now.");
    expect(limitService.reserveGeneration).not.toHaveBeenCalled();
  });

  it("asks for a description without calling it routing", async () => {
    const result = await generateImageForMailTool.handler({}, vscodeContext);

    expect(result.status).toBe("no_prompt");
    expectOwnImageRedirect(result as never, "Letter IRL needs a description to make an image.");
  });

  it("treats a context that names no app as an app with no generation of its own", async () => {
    process.env.LETTER_IRL_IMAGE_GEN_MODE = "off";

    const result = await generateImageForMailTool.handler({ prompt: "a walrus" }, unnamedContext);

    expectOwnImageRedirect(result as never, "Letter IRL is not making images here right now.");
  });
});

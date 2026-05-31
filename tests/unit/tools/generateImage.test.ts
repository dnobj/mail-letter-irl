/**
 * Unit tests for generate_image tool
 *
 * Tests the tool handler with mocked image generation service and Sharp.
 * Verifies correct output shape, context-based next-step guidance,
 * preview creation, temp URL generation, generation limits, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "../../../src/contracts/types.js";

// Mock the image generation service
vi.mock("../../../src/services/imageGenerationService.js", () => ({
  generateImage: vi.fn(),
  ImageGenerationError: class ImageGenerationError extends Error {
    code: string;
    userMessage: string;
    constructor(code: string, userMessage: string) {
      super(userMessage);
      this.code = code;
      this.userMessage = userMessage;
      this.name = "ImageGenerationError";
    }
  }
}));

// Mock sharp
vi.mock("sharp", () => {
  const mockSharp = vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("tinypreview"))
  }));
  return { default: mockSharp };
});

// Mock temp image store
vi.mock("../../../src/services/tempImageStore.js", () => ({
  storeImage: vi.fn().mockReturnValue("abc123def456abc123def456abc12345")
}));

// Mock image generation limit service
vi.mock("../../../src/services/imageGenerationLimitService.js", () => ({
  releaseGenerationReservation: vi.fn(),
  reserveGeneration: vi.fn()
}));

import {
  generateImage,
  ImageGenerationError
} from "../../../src/services/imageGenerationService.js";
import { storeImage } from "../../../src/services/tempImageStore.js";
import {
  releaseGenerationReservation,
  reserveGeneration
} from "../../../src/services/imageGenerationLimitService.js";
import { generateImageTool } from "../../../src/tools/generateImage.js";

const mockGenerateImage = generateImage as ReturnType<typeof vi.fn>;
const mockStoreImage = storeImage as ReturnType<typeof vi.fn>;
const mockReleaseReservation = releaseGenerationReservation as ReturnType<typeof vi.fn>;
const mockReserveGeneration = reserveGeneration as ReturnType<typeof vi.fn>;

const createMockContext = (): ToolContext => ({
  user: {
    userId: "test-user-id",
    creditsRemaining: 5,
    orders: []
  } as any,
  correlationId: "test-correlation-id",
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn()
  } as any,
  now: () => new Date("2026-01-15T12:00:00Z"),
  persist: vi.fn()
});

describe("generate_image tool", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LETTER_IRL_API_URL = "https://api.letterirl.com";
    // Default: reserve generation with plenty remaining
    mockReserveGeneration.mockResolvedValue({
      reserved: true,
      used: 3,
      allowance: 25,
      remaining: 22
    });
    mockReleaseReservation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(generateImageTool.name).toBe("generate_image");
    });

    it("should describe reusing an existing image instead of regenerating", () => {
      expect(generateImageTool.description).toContain("imageUrl to pass to a preview tool");
      expect(generateImageTool.description).toContain("use that existing image instead of calling this tool again");
    });

    it("should not be readOnly", () => {
      expect(generateImageTool.readOnly).toBe(false);
    });

    it("should reference GenerateImageCard widget", () => {
      expect(generateImageTool.meta["openai/outputTemplate"]).toBe(
        "ui://widgets/GenerateImageCard.html"
      );
    });

    it("should be widget accessible", () => {
      expect(generateImageTool.meta["openai/widgetAccessible"]).toBe(true);
    });
  });

  describe("handler - success cases", () => {
    it("should return preview and image URL", async () => {
      mockGenerateImage.mockResolvedValueOnce({
        base64Data: "fakeb64data"
      });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "sunset over mountains" },
        context
      );

      expect(result.generatedImagePreview).toBeDefined();
      expect(result.generatedImageUrl).toContain("/api/temp-image/");
      expect(result.message).toContain("Image generated");
    });

    it("should create preview via Sharp", async () => {
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "a sunset" },
        context
      );

      // Preview should be the base64-encoded result from Sharp mock
      expect(result.generatedImagePreview).toBe(
        Buffer.from("tinypreview").toString("base64")
      );
    });

    it("should store full image in temp store", async () => {
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fullb64data" });

      const context = createMockContext();
      await generateImageTool.handler(
        { prompt: "a sunset" },
        context
      );

      expect(mockStoreImage).toHaveBeenCalledWith("fullb64data");
    });

    it("should build image URL from API URL env var", async () => {
      process.env.LETTER_IRL_API_URL = "https://dev-api.letterirl.com";
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "a sunset" },
        context
      );

      expect(result.generatedImageUrl).toContain(
        "https://dev-api.letterirl.com/api/temp-image/"
      );
    });

    it("should suggest postcard preview for postcard context", async () => {
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "a beach", context: "postcard" },
        context
      );

      expect(result.suggestedNextStep).toContain(
        "quote_and_preview_postcard"
      );
    });

    it("should suggest header image preview for header_image context", async () => {
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "a logo", context: "header_image" },
        context
      );

      expect(result.suggestedNextStep).toContain(
        "quote_and_preview_letter_with_header_image"
      );
    });

    it("should suggest inline image preview for inline_image context", async () => {
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "a cat", context: "inline_image" },
        context
      );

      expect(result.suggestedNextStep).toContain(
        "quote_and_preview_letter_with_image"
      );
    });

    it("should provide generic next step when no context given", async () => {
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "a flower" },
        context
      );

      expect(result.suggestedNextStep).toContain("quote_and_preview_postcard");
    });

    it("should pass context to service", async () => {
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      await generateImageTool.handler(
        { prompt: "a sunset", context: "postcard" },
        context
      );

      expect(mockGenerateImage).toHaveBeenCalledWith("a sunset", {
        context: "postcard"
      });
    });

    it("should include generationsRemaining in output", async () => {
      mockReserveGeneration.mockResolvedValueOnce({
        reserved: true,
        used: 6,
        allowance: 25,
        remaining: 19
      });
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "a sunset" },
        context
      );

      expect(result.generationsRemaining).toBe(19);
    });

    it("should reserve generation before API call", async () => {
      mockGenerateImage.mockResolvedValueOnce({ base64Data: "fakeb64" });

      const context = createMockContext();
      await generateImageTool.handler(
        { prompt: "a sunset" },
        context
      );

      expect(mockReserveGeneration).toHaveBeenCalledWith("test-user-id");
      expect(mockGenerateImage).toHaveBeenCalled();
      expect(mockReleaseReservation).not.toHaveBeenCalled();
    });
  });

  describe("handler - generation limits", () => {
    it("should reserve generation before calling OpenAI", async () => {
      mockReserveGeneration.mockResolvedValueOnce({
        reserved: false,
        used: 10,
        allowance: 10,
        remaining: 0
      });

      const context = createMockContext();
      await expect(
        generateImageTool.handler({ prompt: "a sunset" }, context)
      ).rejects.toThrow("used all your image generations");

      // Should NOT have called generateImage
      expect(mockGenerateImage).not.toHaveBeenCalled();
    });

    it("should not release reservation when limit is exhausted", async () => {
      mockReserveGeneration.mockResolvedValueOnce({
        reserved: false,
        used: 10,
        allowance: 10,
        remaining: 0
      });

      const context = createMockContext();
      try {
        await generateImageTool.handler({ prompt: "a sunset" }, context);
      } catch {
        // expected
      }

      expect(mockReleaseReservation).not.toHaveBeenCalled();
    });

    it("should include purchase suggestion in limit error message", async () => {
      mockReserveGeneration.mockResolvedValueOnce({
        reserved: false,
        used: 5,
        allowance: 5,
        remaining: 0
      });

      const context = createMockContext();
      await expect(
        generateImageTool.handler({ prompt: "a sunset" }, context)
      ).rejects.toThrow("Purchase more letters");
    });

    it("should log warning when limit is reached", async () => {
      mockReserveGeneration.mockResolvedValueOnce({
        reserved: false,
        used: 10,
        allowance: 10,
        remaining: 0
      });

      const context = createMockContext();
      try {
        await generateImageTool.handler({ prompt: "a sunset" }, context);
      } catch {
        // expected
      }

      expect(context.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "generate_image.limit_reached"
        }),
        expect.any(String)
      );
    });
  });

  describe("handler - error cases", () => {
    it("should throw user-friendly error for content policy violation", async () => {
      const error = new (ImageGenerationError as any)(
        "CONTENT_POLICY_VIOLATION",
        "The image request was declined due to content policy."
      );
      mockGenerateImage.mockRejectedValueOnce(error);

      const context = createMockContext();
      await expect(
        generateImageTool.handler(
          { prompt: "inappropriate content" },
          context
        )
      ).rejects.toThrow("content policy");
      expect(mockReleaseReservation).toHaveBeenCalledWith("test-user-id");
    });

    it("should throw user-friendly error for missing API key", async () => {
      const error = new (ImageGenerationError as any)(
        "MISSING_API_KEY",
        "Image generation is not configured."
      );
      mockGenerateImage.mockRejectedValueOnce(error);

      const context = createMockContext();
      await expect(
        generateImageTool.handler({ prompt: "a sunset" }, context)
      ).rejects.toThrow("not configured");
    });

    it("should throw generic error for unexpected failures", async () => {
      mockGenerateImage.mockRejectedValueOnce(new Error("Network timeout"));

      const context = createMockContext();
      await expect(
        generateImageTool.handler({ prompt: "a sunset" }, context)
      ).rejects.toThrow("Please try again");
    });

    it("should log ImageGenerationError as warning", async () => {
      const error = new (ImageGenerationError as any)(
        "RATE_LIMITED",
        "Too many requests"
      );
      mockGenerateImage.mockRejectedValueOnce(error);

      const context = createMockContext();
      try {
        await generateImageTool.handler({ prompt: "a sunset" }, context);
      } catch {
        // expected
      }

      expect(context.logger.warn).toHaveBeenCalled();
    });

    it("should log unexpected errors as error", async () => {
      mockGenerateImage.mockRejectedValueOnce(new Error("Network timeout"));

      const context = createMockContext();
      try {
        await generateImageTool.handler({ prompt: "a sunset" }, context);
      } catch {
        // expected
      }

      expect(context.logger.error).toHaveBeenCalled();
    });
  });
});

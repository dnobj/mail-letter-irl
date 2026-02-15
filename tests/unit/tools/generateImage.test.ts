/**
 * Unit tests for generate_image tool
 *
 * Tests the tool handler with mocked image generation service.
 * Verifies correct output shape, context-based next-step guidance,
 * and error handling for various failure scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

import {
  generateImage,
  ImageGenerationError
} from "../../../src/services/imageGenerationService.js";
import { generateImageTool } from "../../../src/tools/generateImage.js";

const mockGenerateImage = generateImage as ReturnType<typeof vi.fn>;

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(generateImageTool.name).toBe("generate_image");
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
    it("should return base64 data and message", async () => {
      mockGenerateImage.mockResolvedValueOnce({
        base64Data: "fakeb64data"
      });

      const context = createMockContext();
      const result = await generateImageTool.handler(
        { prompt: "sunset over mountains" },
        context
      );

      expect(result.generatedImageBase64).toBe("fakeb64data");
      expect(result.message).toContain("Image generated");
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

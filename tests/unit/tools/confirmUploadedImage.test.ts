/**
 * Unit tests for confirm_uploaded_image tool
 *
 * Tests that the relay tool returns the correct imageUrl and
 * suggestedNextStep based on context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB module so recentUploadStore doesn't hit a real database
vi.mock("../../../src/db/index.js", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] })
}));

import { confirmUploadedImageTool } from "../../../src/tools/confirmUploadedImage.js";
import type { ToolContext } from "../../../src/contracts/types.js";
import {
  clearRecentUploadedImages,
  getRecentUploadedImage
} from "../../../src/services/recentUploadStore.js";

const createMockContext = (): ToolContext => ({
  user: {
    userId: "test-user-id",
    email: "test@example.com",
    creditsRemaining: 5,
    orders: [],
    activeQuote: null
  } as any,
  correlationId: "test-correlation-id",
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn()
  } as any,
  now: () => new Date("2025-12-29T12:00:00Z"),
  persist: vi.fn()
});

const TEST_URL = "https://files.oaiusercontent.com/file-abc123";

describe("confirm_uploaded_image tool", () => {
  beforeEach(() => {
    clearRecentUploadedImages();
  });

  describe("handler", () => {
    it("should return ready status with imageUrl", async () => {
      const context = createMockContext();
      const result = await confirmUploadedImageTool.handler(
        { imageUrl: TEST_URL },
        context
      );

      expect(result.status).toBe("ready");
      expect(result.imageUrl).toBe(TEST_URL);
    });

    it("should return postcard next step when context is 'postcard'", async () => {
      const context = createMockContext();
      const result = await confirmUploadedImageTool.handler(
        { imageUrl: TEST_URL, context: "postcard" },
        context
      );

      expect(result.suggestedNextStep).toContain("quote_and_preview_postcard");
      expect(result.suggestedNextStep).toContain(TEST_URL);
    });

    it("should return header_image next step when context is 'header_image'", async () => {
      const context = createMockContext();
      const result = await confirmUploadedImageTool.handler(
        { imageUrl: TEST_URL, context: "header_image" },
        context
      );

      expect(result.suggestedNextStep).toContain("quote_and_preview_letter_with_header_image");
      expect(result.suggestedNextStep).toContain(TEST_URL);
    });

    it("should return inline_image next step when context is 'inline_image'", async () => {
      const context = createMockContext();
      const result = await confirmUploadedImageTool.handler(
        { imageUrl: TEST_URL, context: "inline_image" },
        context
      );

      expect(result.suggestedNextStep).toContain("quote_and_preview_letter_with_image");
      expect(result.suggestedNextStep).toContain(TEST_URL);
    });

    it("should return generic next step when no context provided", async () => {
      const context = createMockContext();
      const result = await confirmUploadedImageTool.handler(
        { imageUrl: TEST_URL },
        context
      );

      expect(result.suggestedNextStep).toContain("quote_and_preview_postcard or a letter preview tool");
      expect(result.suggestedNextStep).toContain(TEST_URL);
    });

    it("should return generic next step for unknown context", async () => {
      const context = createMockContext();
      const result = await confirmUploadedImageTool.handler(
        { imageUrl: TEST_URL, context: "unknown" },
        context
      );

      expect(result.suggestedNextStep).toContain("quote_and_preview_postcard or a letter preview tool");
    });

    it("should log invocation with imageUrl and context", async () => {
      const context = createMockContext();
      await confirmUploadedImageTool.handler(
        { imageUrl: TEST_URL, context: "postcard" },
        context
      );

      expect(context.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "confirm_uploaded_image.invoked",
          imageUrl: TEST_URL,
          imageContext: "postcard"
        }),
        "Confirm uploaded image invoked"
      );
    });

    it("should store the uploaded image URL for per-user fallback", async () => {
      const context = createMockContext();
      await confirmUploadedImageTool.handler(
        { imageUrl: TEST_URL, context: "postcard" },
        context
      );

      const recent = await getRecentUploadedImage(context.user.userId, "postcard");
      expect(recent).not.toBeNull();
      expect(recent?.imageUrl).toBe(TEST_URL);
    });
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(confirmUploadedImageTool.name).toBe("confirm_uploaded_image");
    });

    it("should not be readOnly", () => {
      expect(confirmUploadedImageTool.readOnly).toBe(false);
    });

    it("should be widget accessible", () => {
      expect(confirmUploadedImageTool.meta["openai/widgetAccessible"]).toBe(true);
    });

    it("should not have an outputTemplate (no widget)", () => {
      expect(confirmUploadedImageTool.meta["openai/outputTemplate"]).toBeUndefined();
    });
  });
});

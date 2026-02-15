/**
 * Unit tests for upload_image tool
 *
 * Tests that the tool handler returns the expected static response
 * with correct guidance based on context hint.
 *
 * User Story: US-POSTCARD-04 (Mobile Image Graceful Degradation)
 */

import { describe, it, expect, vi } from "vitest";
import { uploadImageTool } from "../../../src/tools/uploadImage.js";
import type { ToolContext } from "../../../src/contracts/types.js";

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

describe("upload_image tool", () => {
  describe("handler", () => {
    it("should return awaiting_upload status", async () => {
      const context = createMockContext();
      const result = await uploadImageTool.handler({}, context);

      expect(result.status).toBe("awaiting_upload");
    });

    it("should return accepted formats and max size", async () => {
      const context = createMockContext();
      const result = await uploadImageTool.handler({}, context);

      expect(result.acceptedFormats).toBe("JPEG, PNG, WebP");
      expect(result.maxSizeMB).toBe(10);
    });

    it("should return default message when no context provided", async () => {
      const context = createMockContext();
      const result = await uploadImageTool.handler({}, context);

      expect(result.message).toBe(
        "Select a photo to use in your letter or postcard."
      );
      expect(result.context).toBe("");
    });

    it("should return postcard guidance when context is 'postcard'", async () => {
      const context = createMockContext();
      const result = await uploadImageTool.handler(
        { context: "postcard" },
        context
      );

      expect(result.message).toBe(
        "Select a photo for the front of your postcard."
      );
      expect(result.context).toBe("postcard");
    });

    it("should return header_image guidance when context is 'header_image'", async () => {
      const context = createMockContext();
      const result = await uploadImageTool.handler(
        { context: "header_image" },
        context
      );

      expect(result.message).toBe(
        "Select a header image for the top of your letter."
      );
      expect(result.context).toBe("header_image");
    });

    it("should return inline_image guidance when context is 'inline_image'", async () => {
      const context = createMockContext();
      const result = await uploadImageTool.handler(
        { context: "inline_image" },
        context
      );

      expect(result.message).toBe(
        "Select a photo to include in your letter."
      );
      expect(result.context).toBe("inline_image");
    });

    it("should return default message for unknown context", async () => {
      const context = createMockContext();
      const result = await uploadImageTool.handler(
        { context: "unknown_context" },
        context
      );

      expect(result.message).toBe(
        "Select a photo to use in your letter or postcard."
      );
      expect(result.context).toBe("unknown_context");
    });
  });

  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(uploadImageTool.name).toBe("upload_image");
    });

    it("should not be readOnly", () => {
      expect(uploadImageTool.readOnly).toBe(false);
    });

    it("should reference ImageUploadCard widget in meta", () => {
      expect(uploadImageTool.meta["openai/outputTemplate"]).toBe(
        "ui://widgets/ImageUploadCard.html"
      );
    });

    it("should be widget accessible", () => {
      expect(uploadImageTool.meta["openai/widgetAccessible"]).toBe(true);
    });
  });
});

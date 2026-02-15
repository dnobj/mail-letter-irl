/**
 * Unit tests for imageGenerationService
 *
 * Tests the OpenAI Images API integration with mocked fetch.
 * Covers success path, size mapping, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateImage,
  ImageGenerationError
} from "../../../src/services/imageGenerationService.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("imageGenerationService", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "sk-test-key-123";
    // Clear model/quality overrides
    delete process.env.OPENAI_IMAGE_MODEL;
    delete process.env.OPENAI_IMAGE_QUALITY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function mockSuccessResponse(b64Data = "fakeBase64ImageData") {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ b64_json: b64Data }]
        })
    });
  }

  function mockErrorResponse(
    status: number,
    errorCode?: string,
    errorMessage?: string
  ) {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      json: () =>
        Promise.resolve({
          error: {
            code: errorCode,
            message: errorMessage
          }
        })
    });
  }

  describe("generateImage - success", () => {
    it("should call OpenAI API and return base64 data", async () => {
      mockSuccessResponse("testBase64Data");

      const result = await generateImage("sunset over mountains");

      expect(result.base64Data).toBe("testBase64Data");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("should call the correct API endpoint", async () => {
      mockSuccessResponse();

      await generateImage("a beach");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/images/generations",
        expect.any(Object)
      );
    });

    it("should include Authorization header", async () => {
      mockSuccessResponse();

      await generateImage("a sunset");

      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.headers.Authorization).toBe("Bearer sk-test-key-123");
    });

    it("should use gpt-image-1.5 model by default", async () => {
      mockSuccessResponse();

      await generateImage("a sunset");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe("gpt-image-1.5");
    });

    it("should use configurable model from env var", async () => {
      process.env.OPENAI_IMAGE_MODEL = "gpt-image-1-mini";
      mockSuccessResponse();

      await generateImage("a sunset");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe("gpt-image-1-mini");
    });

    it("should use medium quality by default", async () => {
      mockSuccessResponse();

      await generateImage("a sunset");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.quality).toBe("medium");
    });

    it("should use configurable quality from env var", async () => {
      process.env.OPENAI_IMAGE_QUALITY = "low";
      mockSuccessResponse();

      await generateImage("a sunset");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.quality).toBe("low");
    });

    it("should request JPEG output at 85 compression", async () => {
      mockSuccessResponse();

      await generateImage("a sunset");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.output_format).toBe("jpeg");
      expect(callBody.output_compression).toBe(85);
    });

    it("should request n=1", async () => {
      mockSuccessResponse();

      await generateImage("a flower");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.n).toBe(1);
    });
  });

  describe("generateImage - size mapping", () => {
    it("should use 1536x1024 for postcard context", async () => {
      mockSuccessResponse();

      await generateImage("a beach", { context: "postcard" });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.size).toBe("1536x1024");
    });

    it("should use 1536x1024 for header_image context", async () => {
      mockSuccessResponse();

      await generateImage("a logo", { context: "header_image" });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.size).toBe("1536x1024");
    });

    it("should use 1024x1024 for inline_image context", async () => {
      mockSuccessResponse();

      await generateImage("a cat", { context: "inline_image" });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.size).toBe("1024x1024");
    });

    it("should use 1024x1024 when no context provided", async () => {
      mockSuccessResponse();

      await generateImage("a flower");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.size).toBe("1024x1024");
    });
  });

  describe("generateImage - validation", () => {
    it("should throw INVALID_PROMPT for empty prompt", async () => {
      await expect(generateImage("")).rejects.toThrow("describe the image");
    });

    it("should throw INVALID_PROMPT for whitespace-only prompt", async () => {
      await expect(generateImage("   ")).rejects.toThrow("describe the image");
    });

    it("should throw MISSING_API_KEY when env var not set", async () => {
      delete process.env.OPENAI_API_KEY;

      await expect(generateImage("a sunset")).rejects.toThrow("not configured");
    });

    it("should throw ImageGenerationError for validation failures", async () => {
      try {
        await generateImage("");
      } catch (error) {
        expect(error).toBeInstanceOf(ImageGenerationError);
        expect((error as ImageGenerationError).code).toBe("INVALID_PROMPT");
      }
    });
  });

  describe("generateImage - error handling", () => {
    it("should throw CONTENT_POLICY_VIOLATION for 400 with policy code", async () => {
      mockErrorResponse(400, "content_policy_violation", "Your request was rejected");

      await expect(generateImage("bad content")).rejects.toThrow(
        "content policy"
      );
    });

    it("should throw RATE_LIMITED for 429 status", async () => {
      mockErrorResponse(429, undefined, "Rate limit exceeded");

      await expect(generateImage("a sunset")).rejects.toThrow(
        "temporarily busy"
      );
    });

    it("should throw API_ERROR for 500 status with message", async () => {
      mockErrorResponse(500, undefined, "Internal server error");

      await expect(generateImage("a sunset")).rejects.toThrow(
        "Internal server error"
      );
    });

    it("should throw API_ERROR with fallback message for unknown errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.resolve({})
      });

      await expect(generateImage("a sunset")).rejects.toThrow(
        "Please try again"
      );
    });

    it("should throw API_ERROR when response has no b64_json", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{}]
          })
      });

      await expect(generateImage("a sunset")).rejects.toThrow("no data");
    });

    it("should handle JSON parse failure in error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("invalid json"))
      });

      await expect(generateImage("a sunset")).rejects.toThrow(
        "Please try again"
      );
    });
  });
});

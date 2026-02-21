/**
 * Unit tests for tempImageHandler
 *
 * Tests the HTTP handler that serves temporary generated images.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleTempImageRequest } from "../../../src/api/tempImageHandler.js";

// Mock the temp image store
vi.mock("../../../src/services/tempImageStore.js", () => ({
  getImage: vi.fn()
}));

import { getImage } from "../../../src/services/tempImageStore.js";

const mockGetImage = getImage as ReturnType<typeof vi.fn>;

function createMockReq(method: string) {
  return { method } as any;
}

function createMockRes() {
  const res: any = {
    writeHead: vi.fn(),
    end: vi.fn(),
    statusCode: 200
  };
  return res;
}

describe("tempImageHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("route matching", () => {
    it("should return false for non-matching paths", async () => {
      const req = createMockReq("GET");
      const res = createMockRes();
      const handled = await handleTempImageRequest(req, res, "/api/other");
      expect(handled).toBe(false);
    });

    it("should return false for non-GET methods", async () => {
      const req = createMockReq("POST");
      const res = createMockRes();
      const handled = await handleTempImageRequest(
        req, res, "/api/temp-image/abcdef1234567890abcdef1234567890"
      );
      expect(handled).toBe(false);
    });

    it("should return false for invalid token format", async () => {
      const req = createMockReq("GET");
      const res = createMockRes();
      const handled = await handleTempImageRequest(
        req, res, "/api/temp-image/short"
      );
      expect(handled).toBe(false);
    });

    it("should match valid 32-char hex token", async () => {
      mockGetImage.mockReturnValue(null);
      const req = createMockReq("GET");
      const res = createMockRes();
      const handled = await handleTempImageRequest(
        req, res, "/api/temp-image/abcdef1234567890abcdef1234567890"
      );
      expect(handled).toBe(true);
    });
  });

  describe("image serving", () => {
    it("should return 404 when image not found", async () => {
      mockGetImage.mockReturnValue(null);
      const req = createMockReq("GET");
      const res = createMockRes();

      await handleTempImageRequest(
        req, res, "/api/temp-image/abcdef1234567890abcdef1234567890"
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    it("should serve image as JPEG when found", async () => {
      const fakeBase64 = Buffer.from("fake-image-data").toString("base64");
      mockGetImage.mockReturnValue(fakeBase64);
      const req = createMockReq("GET");
      const res = createMockRes();

      await handleTempImageRequest(
        req, res, "/api/temp-image/abcdef1234567890abcdef1234567890"
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        "Content-Type": "image/jpeg"
      }));
      expect(res.end).toHaveBeenCalledWith(expect.any(Buffer));
    });

    it("should set Cache-Control header", async () => {
      const fakeBase64 = Buffer.from("data").toString("base64");
      mockGetImage.mockReturnValue(fakeBase64);
      const req = createMockReq("GET");
      const res = createMockRes();

      await handleTempImageRequest(
        req, res, "/api/temp-image/abcdef1234567890abcdef1234567890"
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        "Cache-Control": "private, max-age=900"
      }));
    });
  });
});

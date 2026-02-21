/**
 * Unit tests for tempImageStore
 *
 * Tests the in-memory temp image store used by generate_image tool.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { storeImage, getImage, getStoreSize } from "../../../src/services/tempImageStore.js";

describe("tempImageStore", () => {
  describe("storeImage", () => {
    it("should return a 32-character hex token", () => {
      const token = storeImage("someBase64Data");
      expect(token).toMatch(/^[a-f0-9]{32}$/);
    });

    it("should return unique tokens for each call", () => {
      const token1 = storeImage("data1");
      const token2 = storeImage("data2");
      expect(token1).not.toBe(token2);
    });
  });

  describe("getImage", () => {
    it("should retrieve stored image by token", () => {
      const token = storeImage("testBase64Data");
      const result = getImage(token);
      expect(result).toBe("testBase64Data");
    });

    it("should return null for unknown token", () => {
      const result = getImage("nonexistent1234567890abcdef12345");
      expect(result).toBeNull();
    });

    it("should allow multiple retrievals of same image", () => {
      const token = storeImage("reusableData");
      expect(getImage(token)).toBe("reusableData");
      expect(getImage(token)).toBe("reusableData");
    });
  });

  describe("getStoreSize", () => {
    it("should reflect number of stored images", () => {
      const before = getStoreSize();
      storeImage("newImage");
      expect(getStoreSize()).toBeGreaterThanOrEqual(before + 1);
    });
  });
});

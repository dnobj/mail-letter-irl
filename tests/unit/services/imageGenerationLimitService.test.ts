/**
 * Unit tests for imageGenerationLimitService
 *
 * Tests allowance calculation, limit checking, and generation recording.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module
vi.mock("../../../src/db/index.js", () => ({
  query: vi.fn()
}));

import { query } from "../../../src/db/index.js";
import {
  getGenerationQuota,
  checkGenerationLimit,
  recordGeneration
} from "../../../src/services/imageGenerationLimitService.js";

const mockQuery = query as ReturnType<typeof vi.fn>;

describe("imageGenerationLimitService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getGenerationQuota", () => {
    it("should compute allowance from credits_purchased", async () => {
      // 10 credits_purchased = 5 letters = 25 generations
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 10, image_generations_used: 0 }],
        rowCount: 1
      });

      const quota = await getGenerationQuota("user-1");

      expect(quota.allowance).toBe(25);
      expect(quota.used).toBe(0);
      expect(quota.remaining).toBe(25);
    });

    it("should handle odd credits_purchased (floor division)", async () => {
      // 7 credits = floor(7/2) = 3 letters = 15 generations
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 7, image_generations_used: 0 }],
        rowCount: 1
      });

      const quota = await getGenerationQuota("user-1");

      expect(quota.allowance).toBe(15);
      expect(quota.remaining).toBe(15);
    });

    it("should subtract used from allowance", async () => {
      // 4 credits = 2 letters = 10 allowed, 3 used → 7 remaining
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 4, image_generations_used: 3 }],
        rowCount: 1
      });

      const quota = await getGenerationQuota("user-1");

      expect(quota.allowance).toBe(10);
      expect(quota.used).toBe(3);
      expect(quota.remaining).toBe(7);
    });

    it("should return 0 remaining when used exceeds allowance (e.g. after refund)", async () => {
      // credits_purchased dropped to 2 (1 letter = 5 allowed), but 8 already used
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 2, image_generations_used: 8 }],
        rowCount: 1
      });

      const quota = await getGenerationQuota("user-1");

      expect(quota.allowance).toBe(5);
      expect(quota.used).toBe(8);
      expect(quota.remaining).toBe(0);
    });

    it("should return 0 allowance for user with 0 credits_purchased", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 0, image_generations_used: 0 }],
        rowCount: 1
      });

      const quota = await getGenerationQuota("user-1");

      expect(quota.allowance).toBe(0);
      expect(quota.remaining).toBe(0);
    });

    it("should return 0s for non-existent user", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0
      });

      const quota = await getGenerationQuota("nonexistent");

      expect(quota.used).toBe(0);
      expect(quota.allowance).toBe(0);
      expect(quota.remaining).toBe(0);
    });

    it("should return 0 allowance for 1 credit_purchased (not enough for a letter)", async () => {
      // 1 credit = floor(1/2) = 0 letters = 0 generations
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 1, image_generations_used: 0 }],
        rowCount: 1
      });

      const quota = await getGenerationQuota("user-1");

      expect(quota.allowance).toBe(0);
      expect(quota.remaining).toBe(0);
    });

    it("should compute correctly for large credit amounts", async () => {
      // 100 credits = 50 letters = 250 generations, 50 used → 200 remaining
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 100, image_generations_used: 50 }],
        rowCount: 1
      });

      const quota = await getGenerationQuota("user-1");

      expect(quota.allowance).toBe(250);
      expect(quota.remaining).toBe(200);
    });
  });

  describe("checkGenerationLimit", () => {
    it("should return allowed=true when remaining > 0", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 4, image_generations_used: 0 }],
        rowCount: 1
      });

      const check = await checkGenerationLimit("user-1");

      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(10);
    });

    it("should return allowed=false when remaining = 0", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 4, image_generations_used: 10 }],
        rowCount: 1
      });

      const check = await checkGenerationLimit("user-1");

      expect(check.allowed).toBe(false);
      expect(check.remaining).toBe(0);
    });

    it("should return allowed=false for user with no purchases", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ credits_purchased: 0, image_generations_used: 0 }],
        rowCount: 1
      });

      const check = await checkGenerationLimit("user-1");

      expect(check.allowed).toBe(false);
      expect(check.allowance).toBe(0);
    });

    it("should return allowed=false for non-existent user", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0
      });

      const check = await checkGenerationLimit("nonexistent");

      expect(check.allowed).toBe(false);
    });
  });

  describe("recordGeneration", () => {
    it("should increment image_generations_used by 1", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recordGeneration("user-1");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("image_generations_used = image_generations_used + 1"),
        ["user-1"]
      );
    });
  });
});

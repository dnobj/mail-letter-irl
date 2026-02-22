/**
 * Unit tests for get_account_balance tool
 *
 * Tests the balance handler including image generation quota info.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../../../src/contracts/types.js";

// Mock credit service
vi.mock("../../../src/services/creditService.js", () => ({
  getBalance: vi.fn(),
  getDetailedBalance: vi.fn()
}));

// Mock user service
vi.mock("../../../src/services/userService.js", () => ({
  findUser: vi.fn()
}));

// Mock image generation limit service
vi.mock("../../../src/services/imageGenerationLimitService.js", () => ({
  getGenerationQuota: vi.fn()
}));

import { getDetailedBalance } from "../../../src/services/creditService.js";
import { findUser } from "../../../src/services/userService.js";
import { getGenerationQuota } from "../../../src/services/imageGenerationLimitService.js";
import { getAccountBalanceTool } from "../../../src/tools/getAccountBalance.js";

const mockGetDetailedBalance = getDetailedBalance as ReturnType<typeof vi.fn>;
const mockFindUser = findUser as ReturnType<typeof vi.fn>;
const mockGetGenerationQuota = getGenerationQuota as ReturnType<typeof vi.fn>;

const createMockContext = (userId = "google-oauth2|test-123"): ToolContext => ({
  user: {
    userId,
    creditsRemaining: 10,
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

describe("get_account_balance tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks
    mockFindUser.mockResolvedValue({
      user_id: "google-oauth2|test-123",
      email: "test@example.com"
    });
    mockGetDetailedBalance.mockResolvedValue({
      totalAvailable: 10,
      expiringSoon: 0,
      expiringDates: [],
      neverExpiring: 10,
      bySource: []
    });
    mockGetGenerationQuota.mockResolvedValue({
      used: 3,
      allowance: 25,
      remaining: 22
    });
  });

  it("should include imageGenerationsRemaining in response", async () => {
    const context = createMockContext();
    const result = await getAccountBalanceTool.handler({} as any, context);

    expect(result.imageGenerationsRemaining).toBe(22);
  });

  it("should include imageGenerationsAllowance in response", async () => {
    const context = createMockContext();
    const result = await getAccountBalanceTool.handler({} as any, context);

    expect(result.imageGenerationsAllowance).toBe(25);
  });

  it("should handle generation quota fetch failure gracefully", async () => {
    mockGetGenerationQuota.mockRejectedValueOnce(new Error("DB error"));

    const context = createMockContext();
    const result = await getAccountBalanceTool.handler({} as any, context);

    // Should still return balance, just without generation info
    expect(result.lettersRemaining).toBe(5); // 10 internal credits / 2
    expect(result.imageGenerationsRemaining).toBeUndefined();
    expect(result.imageGenerationsAllowance).toBeUndefined();
  });

  it("should show 0 generation quota for user with no purchases", async () => {
    mockGetGenerationQuota.mockResolvedValueOnce({
      used: 0,
      allowance: 0,
      remaining: 0
    });

    const context = createMockContext();
    const result = await getAccountBalanceTool.handler({} as any, context);

    expect(result.imageGenerationsRemaining).toBe(0);
    expect(result.imageGenerationsAllowance).toBe(0);
  });
});

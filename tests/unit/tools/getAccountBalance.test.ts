/**
 * Unit tests for get_account_balance tool
 *
 * Tests the balance handler including image generation quota info.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "../../../src/contracts/types.js";
import { clientProfileNamed } from "../../../src/auth/clientProfiles.js";
import { describeTool } from "../../../src/server.js";

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

/**
 * Where to buy, per app (#484). Claude read "Letters can be bought without
 * leaving the conversation" in this description and offered to set up a pack
 * purchase, where Claude allows no purchases through connectors (#475).
 */
describe("get_account_balance: where to buy letters", () => {
  const emptyAccount = () =>
    mockGetDetailedBalance.mockResolvedValueOnce({
      totalAvailable: 0,
      expiringSoon: 0,
      expiringDates: [],
      neverExpiring: 0,
      bySource: []
    });
  const inApp = (name: Parameters<typeof clientProfileNamed>[0] | null): ToolContext => ({
    ...createMockContext(),
    ...(name ? { client: clientProfileNamed(name) } : {})
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUser.mockResolvedValue({ user_id: "google-oauth2|test-123", email: "test@example.com" });
    mockGetDetailedBalance.mockResolvedValue({
      totalAvailable: 10,
      expiringSoon: 0,
      expiringDates: [],
      neverExpiring: 10,
      bySource: []
    });
    mockGetGenerationQuota.mockResolvedValue({ used: 0, allowance: 0, remaining: 0 });
    vi.stubEnv("LETTER_IRL_WEBSITE_BASE_URL", "https://website.example");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("has a short title", () => {
    expect(getAccountBalanceTool.title).toBe("Check letter balance");
  });

  it("offers the checkout in the conversation where the app takes purchases", async () => {
    emptyAccount();
    const result = await getAccountBalanceTool.handler({} as any, inApp("chatgpt"));

    expect(result.lettersRemaining).toBe(0);
    expect(result.message).toContain(
      "No letters on this account yet. You can buy a letter pack here, or pay for a single letter as you send it."
    );
    expect(result.message).not.toContain("website.example");
  });

  it.each(["claude", "claude_code", "codex", "vscode", "hermes", "token", "generic", null] as const)(
    "sends %s to the dashboard's letter packs page instead",
    async (name) => {
      emptyAccount();
      const result = await getAccountBalanceTool.handler({} as any, inApp(name));

      // Claude passed on "your Letter IRL dashboard" without the address in
      // CLIENT-01 step 7, so the text asks for the link itself (#475).
      expect(result.message).toContain(
        "No letters on this account yet. Letter packs are bought on the Letter IRL website, not in this app. Give the person this link: https://website.example/dashboard/letter-packs"
      );
      expect(result.message).not.toMatch(/buy a letter pack here|pay for a single letter/);
    }
  );

  it("says nothing about buying while letters remain", async () => {
    const result = await getAccountBalanceTool.handler({} as any, inApp("claude"));

    expect(result.lettersRemaining).toBe(5);
    expect(result.message).not.toMatch(/buy|dashboard/i);
  });

  it("describes where letters are bought, per app", () => {
    expect(describeTool(getAccountBalanceTool, clientProfileNamed("chatgpt"))).toContain(
      "Letters can be bought without leaving the conversation"
    );
    const elsewhere = describeTool(getAccountBalanceTool, clientProfileNamed("claude"));
    expect(elsewhere).toContain("Letter packs are bought on the Letter IRL website");
    expect(elsewhere).not.toMatch(/without leaving the conversation|create_pack_checkout/);
  });
});

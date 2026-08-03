import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../../src/contracts/types.js";

const mocks = vi.hoisted(() => ({
  createJitCheckout: vi.fn()
}));

vi.mock("../../../src/services/commerceService.js", () => ({
  createJitCheckout: mocks.createJitCheckout
}));

import { createMailCheckoutTool } from "../../../src/tools/createMailCheckout.js";

const context = {
  user: {
    userId: "user-1",
    creditsRemaining: 0,
    orders: []
  },
  correlationId: "test-correlation",
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn()
  },
  now: () => new Date("2026-07-31T12:00:00Z"),
  persist: vi.fn()
} as unknown as ToolContext;

describe("create_mail_checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["DRAFT_NOT_FOUND", "DRAFT_NOT_OWNED"])(
    "does not distinguish missing and non-owned drafts for %s",
    async code => {
      mocks.createJitCheckout.mockRejectedValueOnce(
        Object.assign(new Error("internal detail"), { code })
      );

      await expect(
        createMailCheckoutTool.handler({ draftId: "draft-1" }, context)
      ).rejects.toThrow(
        "Draft not found for your account. Please create a new letter or postcard preview."
      );
    }
  );

  it("passes only the authenticated user and draft to commerce", async () => {
    mocks.createJitCheckout.mockResolvedValueOnce({
      orderId: "order-1",
      checkoutUrl: "https://checkout.stripe.com/c/pay/test",
      amountCents: 499,
      currency: "usd",
      productDescription: "Pay & Send One Physical Letter",
      expiresAt: "2026-07-31T12:30:00.000Z",
      status: "checkout_pending",
      reused: false
    });

    await expect(
      createMailCheckoutTool.handler({ draftId: "draft-1" }, context)
    ).resolves.toMatchObject({
      orderId: "order-1",
      amountCents: 499,
      currency: "usd"
    });
    expect(mocks.createJitCheckout).toHaveBeenCalledWith({
      userId: "user-1",
      draftId: "draft-1"
    });
  });

  it("does not expose arbitrary commerce exceptions", async () => {
    const sensitive = "private database exception order-private pi-private";
    mocks.createJitCheckout.mockRejectedValueOnce(new Error(sensitive));

    await expect(
      createMailCheckoutTool.handler({ draftId: "draft-1" }, context)
    ).rejects.toThrow("Unable to create Pay & Send checkout. Please try again.");
  });
});

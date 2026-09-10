import { describe, expect, it, vi } from "vitest";

import { mapDomainError } from "../../../src/admin/commands/runner.js";
import { createStripeCommands } from "../../../src/admin/commands/stripe.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";
import { PackRefundError } from "../../../src/services/packRefundService.js";

const ORDER = {
  order_id: "order_1",
  user_id: "auth0|u1",
  order_type: "letter_pack",
  status: "fulfilled",
  credits: 10,
  amount_cents: 1000,
  amount_known: true,
  currency: "usd",
  stripe_checkout_session_id: "cs_test_session_1",
  stripe_payment_intent_id: "pi_test_1",
  updated_at: new Date("2026-09-06T10:00:00.000Z"),
};

function client(rows: Record<string, unknown>[] = [ORDER]): AdminSqlClient {
  return { query: vi.fn(async () => ({ rows })) } as unknown as AdminSqlClient;
}

function seams() {
  const refundCalls: unknown[] = [];
  const repairCalls: unknown[] = [];
  return {
    refundCalls,
    repairCalls,
    seams: {
      previewPackRefund: vi.fn(async (orderId: string, letters: number) => ({
        orderId,
        letters,
        lettersInPack: 5,
        lettersRemaining: 4,
        lettersRefundedBefore: 0,
        perLetterCents: 200,
        amountCents: letters * 200,
        amountDisplay: `USD ${(letters * 2).toFixed(2)}`,
        currency: "usd",
        previewDigest: "d".repeat(64),
      })),
      refundPackLetters: vi.fn(async (input: unknown) => {
        refundCalls.push(input);
        return { packRefundId: "11111111-1111-4111-8111-111111111111", status: "succeeded" as const, amountCents: 600, replayed: false };
      }),
      packRefundOperations: {} as never,
      repairFulfilledPackGrant: vi.fn(async (input: unknown) => {
        repairCalls.push(input);
        return "repaired" as const;
      }),
      environment: () => ({ LETTER_IRL_PACK_REFUND_COMMAND_ENABLED: "true" }),
    },
  };
}

const execution = {
  commandId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
  actorId: "owner@example.com",
  environment: "development" as const,
  reason: "customer asked",
  client: null,
};

describe("proportional refund command", () => {
  it("validates letters and the reason code", () => {
    const { refundLetters } = createStripeCommands(seams().seams);
    expect(refundLetters.parseInput(new Map([["letters", "3"], ["reasonCode", "customer_request"]]))).toEqual({
      letters: 3,
      reasonCode: "customer_request",
    });
    for (const bad of [
      [["letters", "0"], ["reasonCode", "customer_request"]],
      [["letters", "1.5"], ["reasonCode", "customer_request"]],
      [["letters", "3"], ["reasonCode", "Customer Request"]],
      [["letters", "3"], ["reasonCode", "ab"]],
    ] as Array<Array<[string, string]>>) {
      expect(() => refundLetters.parseInput(new Map(bad))).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));
    }
    expect(refundLetters.verb({ letters: 1, reasonCode: "x_y" })).toBe("REFUND");
  });

  it("binds the preview to the service's own figures and digest, and the order's version", async () => {
    const harness = seams();
    const { refundLetters } = createStripeCommands(harness.seams);
    const preview = await refundLetters.preview(client(), "order_1", { letters: 3, reasonCode: "customer_request" });
    expect(harness.seams.previewPackRefund).toHaveBeenCalledWith("order_1", 3);
    expect(preview.expectedVersion).toBe("2026-09-06T10:00:00.000Z");
    expect(preview.summary).toMatchObject({
      userId: "auth0|u1",
      letters: 3,
      amountCents: 600,
      lettersRemaining: 4,
      servicePreviewDigest: "d".repeat(64),
    });
    expect(preview.display.map(([label]) => label)).toContain("Refund amount");
    expect(preview.warnings.join(" ")).toContain("letters leave the account first");
  });

  it("refuses a missing order and a non-pack order at preview time", async () => {
    const { refundLetters } = createStripeCommands(seams().seams);
    await expect(refundLetters.preview(client([]), "order_x", { letters: 1, reasonCode: "x_y" })).rejects.toMatchObject({ code: "ADMIN_NOT_FOUND" });
    await expect(
      refundLetters.preview(client([{ ...ORDER, order_type: "jit_mail" }]), "order_1", { letters: 1, reasonCode: "x_y" }),
    ).rejects.toMatchObject({ code: "ADMIN_INVALID_STATE" });
  });

  it("hands the service the run id as its idempotency key, the command id and the preview digest", async () => {
    const harness = seams();
    const { refundLetters } = createStripeCommands(harness.seams);
    const preview = await refundLetters.preview(client(), "order_1", { letters: 3, reasonCode: "customer_request" });
    const result = await refundLetters.execute(execution, "order_1", { letters: 3, reasonCode: "customer_request" }, preview);
    expect(result).toEqual({ packRefundId: "11111111-1111-4111-8111-111111111111", status: "succeeded", amountCents: 600, domainReplayed: false });
    expect(harness.refundCalls[0]).toEqual({
      orderId: "order_1",
      letters: 3,
      reasonCode: "customer_request",
      actor: { id: "owner@example.com" },
      idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
      environment: "development",
      adminCommandId: "22222222-2222-4222-8222-222222222222",
      expectedPreviewDigest: "d".repeat(64),
    });
    expect(harness.seams.refundPackLetters).toHaveBeenCalledWith(expect.anything(), harness.seams.packRefundOperations, {
      LETTER_IRL_PACK_REFUND_COMMAND_ENABLED: "true",
    });
  });

  it("is enabled only by the feature flag in the runtime configuration", () => {
    const { refundLetters } = createStripeCommands(seams().seams);
    expect(refundLetters.enabled?.({ packRefundCommandEnabled: true } as never)).toBe(true);
    expect(refundLetters.enabled?.({ packRefundCommandEnabled: false } as never)).toBe(false);
  });

  it("maps the service's refusals onto the admin catalogue", () => {
    expect(mapDomainError(new PackRefundError("PACK_REFUND_DISABLED", "off")).code).toBe("ADMIN_COMMAND_DISABLED");
    expect(mapDomainError(new PackRefundError("PACK_REFUND_PREVIEW_STALE", "stale")).code).toBe("ADMIN_STALE_PREVIEW");
    expect(mapDomainError(new PackRefundError("PACK_REFUND_ALREADY_ISSUED", "dup")).code).toBe("ADMIN_INVALID_STATE");
    expect(mapDomainError(new PackRefundError("PACK_REFUND_NOT_FOUND", "gone")).code).toBe("ADMIN_NOT_FOUND");
    expect(mapDomainError(new PackRefundError("idempotency_conflict", "x")).code).toBe("ADMIN_IDEMPOTENCY_CONFLICT");
    expect(mapDomainError(new Error("boom")).code).toBe("ADMIN_INTERNAL_ERROR");
  });
});

describe("pack grant repair command", () => {
  it("validates the reconciliation figures it is handed", () => {
    const { repairGrant } = createStripeCommands(seams().seams);
    expect(
      repairGrant.parseInput(
        new Map([
          ["stripeSessionId", "cs_test_session_1"],
          ["expectedCredits", "10"],
          ["paidAmountCents", "1000"],
          ["paidCurrency", "USD"],
        ]),
      ),
    ).toEqual({ stripeSessionId: "cs_test_session_1", expectedCredits: 10, paidAmountCents: 1000, paidCurrency: "usd" });
    expect(() =>
      repairGrant.parseInput(new Map([["stripeSessionId", "pi_nope"], ["expectedCredits", "10"], ["paidAmountCents", "1000"], ["paidCurrency", "usd"]])),
    ).toThrowError(expect.objectContaining({ code: "ADMIN_INVALID_REQUEST" }));
  });

  it("previews against the order and warns when the session differs; refuses non-fulfilled orders", async () => {
    const { repairGrant } = createStripeCommands(seams().seams);
    const input = { stripeSessionId: "cs_test_other", expectedCredits: 10, paidAmountCents: 1000, paidCurrency: "usd" };
    const preview = await repairGrant.preview(client(), "order_1", input);
    expect(preview.warnings.join(" ")).toContain("session id differs");
    expect(preview.summary).toMatchObject({ orderCredits: 10, orderAmountCents: 1000, stripeSessionId: "cs_test_other" });
    await expect(repairGrant.preview(client([{ ...ORDER, status: "paid" }]), "order_1", input)).rejects.toMatchObject({
      code: "ADMIN_INVALID_STATE",
    });
  });

  it("calls the exact-match repair and reports its verdict", async () => {
    const harness = seams();
    const { repairGrant } = createStripeCommands(harness.seams);
    const input = { stripeSessionId: "cs_test_session_1", expectedCredits: 10, paidAmountCents: 1000, paidCurrency: "usd" };
    const preview = await repairGrant.preview(client(), "order_1", input);
    expect(await repairGrant.execute(execution, "order_1", input, preview)).toEqual({ result: "repaired" });
    expect(harness.repairCalls[0]).toEqual({ orderId: "order_1", ...input });
  });
});

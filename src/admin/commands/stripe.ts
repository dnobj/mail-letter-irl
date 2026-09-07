import { repairFulfilledPackGrant } from "../../services/commerceService.js";
import {
  PACK_REFUND_REASON_CODE_PATTERN,
  livePackRefundOperations,
  previewPackRefund,
  refundPackLetters,
  type PackRefundOperations,
} from "../../services/packRefundService.js";
import { AdminFoundationError } from "../errors.js";
import { readOrderVersion } from "../queries/orders.js";
import { formatMoney } from "../ui/format.js";
import { mapDomainError, type CommandDefinition } from "./runner.js";

/**
 * The Stripe-side commands. Both wrap services that already carry the
 * money-moving safeguards (#323's letters-first refund with its stored
 * idempotency key and settlement; the exact-match pack grant repair); the
 * panel adds the preview, the typed confirmation, the run row and the audit.
 * The seams exist so the PostgreSQL suite can run them without Stripe.
 */

export interface StripeCommandSeams {
  previewPackRefund: typeof previewPackRefund;
  refundPackLetters: typeof refundPackLetters;
  packRefundOperations: PackRefundOperations;
  repairFulfilledPackGrant: typeof repairFulfilledPackGrant;
  environment: () => NodeJS.ProcessEnv;
}

export interface RefundLettersInput {
  letters: number;
  reasonCode: string;
}

export interface RepairGrantInput {
  stripeSessionId: string;
  expectedCredits: number;
  paidAmountCents: number;
  paidCurrency: string;
}

function positiveInteger(value: string | undefined, max: number): number | null {
  if (value === undefined || !/^\d{1,6}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return parsed >= 1 && parsed <= max ? parsed : null;
}

export function createStripeCommands(overrides: Partial<StripeCommandSeams> = {}) {
  const seams: StripeCommandSeams = {
    previewPackRefund,
    refundPackLetters,
    packRefundOperations: livePackRefundOperations,
    repairFulfilledPackGrant,
    environment: () => process.env,
    ...overrides,
  };

  const refundLetters: CommandDefinition<RefundLettersInput> = {
    name: "order.refund_letters",
    title: "Refund unspent letters",
    action: "order.refund_letters",
    targetType: "order",
    transactional: false,
    verb: () => "REFUND",
    enabled: (config) => config.packRefundCommandEnabled,
    parseInput(fields) {
      const letters = positiveInteger(fields.get("letters"), 500);
      const reasonCode = (fields.get("reasonCode") ?? "").trim();
      if (letters === null || !PACK_REFUND_REASON_CODE_PATTERN.test(reasonCode)) {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return { letters, reasonCode };
    },
    async preview(client, orderId, input) {
      const order = await readOrderVersion(client, orderId);
      if (!order) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (order.orderType !== "letter_pack") throw new AdminFoundationError("ADMIN_INVALID_STATE");
      let figures;
      try {
        // The service's own preview: the same arithmetic and lot attribution
        // the command will use, and the digest it will insist on.
        figures = await seams.previewPackRefund(orderId, input.letters);
      } catch (error) {
        throw mapDomainError(error);
      }
      return {
        targetId: order.orderId,
        summary: {
          userId: order.userId,
          letters: input.letters,
          reasonCode: input.reasonCode,
          amountCents: figures.amountCents,
          currency: figures.currency,
          lettersInPack: figures.lettersInPack,
          lettersRemaining: figures.lettersRemaining,
          lettersRefundedBefore: figures.lettersRefundedBefore,
          perLetterCents: figures.perLetterCents,
          servicePreviewDigest: figures.previewDigest,
          orderStatus: order.status,
        },
        expectedVersion: order.updatedAt.toISOString(),
        display: [
          ["Order", order.orderId],
          ["Account", order.userId],
          ["Pack", `${figures.lettersInPack} letters; ${figures.lettersRemaining} unspent; ${figures.lettersRefundedBefore} refunded before`],
          ["Letters to refund", String(input.letters)],
          ["Per letter", formatMoney(figures.perLetterCents, figures.currency)],
          ["Refund amount", `${formatMoney(figures.amountCents, figures.currency)} (${figures.amountDisplay})`],
          ["Reason code", input.reasonCode],
        ],
        warnings: [
          "The letters leave the account first, then Stripe is asked for the refund; a Stripe failure returns them.",
          "One proportional refund per pack. A later full refund from the Dashboard returns only what is left.",
          "Real money in production: Stripe keeps its processing fee on the refunded amount.",
        ],
      };
    },
    async execute(execution, orderId, input, preview) {
      try {
        const result = await seams.refundPackLetters(
          {
            orderId,
            letters: input.letters,
            reasonCode: input.reasonCode,
            actor: { id: execution.actorId },
            idempotencyKey: execution.idempotencyKey,
            environment: execution.environment,
            adminCommandId: execution.commandId,
            expectedPreviewDigest: String(preview.summary.servicePreviewDigest),
          },
          seams.packRefundOperations,
          seams.environment(),
        );
        return {
          packRefundId: result.packRefundId,
          status: result.status,
          amountCents: result.amountCents,
          domainReplayed: result.replayed,
        };
      } catch (error) {
        throw mapDomainError(error);
      }
    },
  };

  const repairGrant: CommandDefinition<RepairGrantInput> = {
    name: "order.repair_grant",
    title: "Repair a missing pack grant",
    action: "order.repair_grant",
    targetType: "order",
    transactional: false,
    verb: () => "REPAIR",
    parseInput(fields) {
      const stripeSessionId = (fields.get("stripeSessionId") ?? "").trim();
      const expectedCredits = positiveInteger(fields.get("expectedCredits"), 10_000);
      const paidAmount = (fields.get("paidAmountCents") ?? "").trim();
      const paidCurrency = (fields.get("paidCurrency") ?? "").trim().toLowerCase();
      if (
        !/^cs_[A-Za-z0-9_]{8,200}$/.test(stripeSessionId) ||
        expectedCredits === null ||
        !/^\d{1,9}$/.test(paidAmount) ||
        !/^[a-z]{3}$/.test(paidCurrency)
      ) {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return { stripeSessionId, expectedCredits, paidAmountCents: Number(paidAmount), paidCurrency };
    },
    async preview(client, orderId, input) {
      const order = await readOrderVersion(client, orderId);
      if (!order) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (order.orderType !== "letter_pack" || order.status !== "fulfilled") {
        throw new AdminFoundationError("ADMIN_INVALID_STATE");
      }
      const warnings = [
        "The repair refuses anything but an exact match of order, session, credits and amount; a mismatch fails without writing.",
        "Idempotent: a pack that already has its grant reports already_granted and changes nothing.",
      ];
      if (order.stripeCheckoutSessionId && order.stripeCheckoutSessionId !== input.stripeSessionId) {
        warnings.push("The session id differs from the one on the order; the repair will refuse.");
      }
      return {
        targetId: order.orderId,
        summary: {
          userId: order.userId,
          stripeSessionId: input.stripeSessionId,
          expectedCredits: input.expectedCredits,
          paidAmountCents: input.paidAmountCents,
          paidCurrency: input.paidCurrency,
          orderCredits: order.credits,
          orderAmountCents: order.amountCents,
          orderStatus: order.status,
        },
        expectedVersion: order.updatedAt.toISOString(),
        display: [
          ["Order", order.orderId],
          ["Account", order.userId],
          ["Order says", `${order.credits ?? "?"} credits for ${formatMoney(order.amountCents, order.currency)}`],
          ["Reconciliation says", `${input.expectedCredits} credits paid ${formatMoney(input.paidAmountCents, input.paidCurrency)} on session ${input.stripeSessionId}`],
        ],
        warnings,
      };
    },
    async execute(_execution, orderId, input) {
      try {
        const result = await seams.repairFulfilledPackGrant({
          orderId,
          stripeSessionId: input.stripeSessionId,
          expectedCredits: input.expectedCredits,
          paidAmountCents: input.paidAmountCents,
          paidCurrency: input.paidCurrency,
        });
        return { result };
      } catch (error) {
        throw mapDomainError(error);
      }
    },
  };

  return { refundLetters, repairGrant };
}

import { adjustCreditsWithClient } from "../../services/creditService.js";
import {
  countStandingDisputes,
  grantOperatorImageEntitlement,
  liftSendBlock,
  releaseAmountMismatchQuarantine,
} from "../../services/operatorAccountService.js";
import { AdminFoundationError } from "../errors.js";
import { readImageQuota } from "../queries/accounts.js";
import { readOrderVersion } from "../queries/orders.js";
import { mapDomainError, type CommandDefinition } from "./runner.js";

/**
 * Account and order operations that are pure database writes, so each runs
 * inside the runner's transaction on the operator pool: the mutation, the
 * run row and the audit row commit together or not at all.
 */

export interface AccountCommandSeams {
  liftSendBlock: typeof liftSendBlock;
  countStandingDisputes: typeof countStandingDisputes;
  releaseAmountMismatchQuarantine: typeof releaseAmountMismatchQuarantine;
  adjustCreditsWithClient: typeof adjustCreditsWithClient;
  grantOperatorImageEntitlement: typeof grantOperatorImageEntitlement;
}

interface AccountVersion {
  userId: string;
  credits: number;
  creditsPurchased: number;
  sendsBlockedAt: Date | null;
  sendsBlockedReason: string | null;
  updatedAt: Date;
  ledgerAvailable: number;
}

async function readAccountVersion(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }, userId: string): Promise<AccountVersion | null> {
  const result = await client.query(
    `SELECT u.user_id, u.credits, u.credits_purchased, u.sends_blocked_at, u.sends_blocked_reason, u.updated_at,
            (SELECT COALESCE(SUM(remaining_amount), 0) FROM credit_ledger l
              WHERE l.user_id = u.user_id AND l.status = 'active' AND l.remaining_amount > 0
                AND (l.expires_at IS NULL OR l.expires_at > NOW()))::int AS ledger_available
     FROM users u WHERE u.user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    credits: row.credits,
    creditsPurchased: row.credits_purchased,
    sendsBlockedAt: row.sends_blocked_at,
    sendsBlockedReason: row.sends_blocked_reason,
    updatedAt: row.updated_at,
    ledgerAvailable: Number(row.ledger_available),
  };
}

const CREDITS_PER_LETTER = 2;

export interface AdjustBalanceInput {
  letters: number;
  direction: "add" | "remove";
}

export interface GrantImagesInput {
  quantity: number;
}

function requireClient(execution: { client: unknown }): asserts execution is { client: NonNullable<unknown> } {
  if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
}

export function createAccountCommands(overrides: Partial<AccountCommandSeams> = {}) {
  const seams: AccountCommandSeams = {
    liftSendBlock,
    countStandingDisputes,
    releaseAmountMismatchQuarantine,
    adjustCreditsWithClient,
    grantOperatorImageEntitlement,
    ...overrides,
  };

  const unblockSends: CommandDefinition<Record<string, never>> = {
    name: "account.unblock_sends",
    title: "Lift send block",
    action: "account.unblock_sends",
    targetType: "user",
    transactional: true,
    verb: () => "UNBLOCK",
    parseInput: () => ({}),
    async preview(client, userId) {
      const account = await readAccountVersion(client, userId);
      if (!account) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (!account.sendsBlockedAt) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      const standing = await seams.countStandingDisputes(client, userId);
      return {
        targetId: account.userId,
        summary: {
          sendsBlockedReason: account.sendsBlockedReason,
          sendsBlockedAt: account.sendsBlockedAt.toISOString(),
          standingDisputes: standing,
        },
        expectedVersion: account.updatedAt.toISOString(),
        display: [
          ["Account", account.userId],
          ["Blocked since", account.sendsBlockedAt.toISOString()],
          ["Reason", account.sendsBlockedReason ?? "—"],
          ["Disputes still standing", String(standing)],
        ],
        warnings:
          standing > 0
            ? ["A dispute that justifies a block is still open or lost: the command will refuse. Wait for it to close in our favour, or refund deliberately."]
            : ["The customer can send again immediately. The dispute history stays on the account."],
      };
    },
    async execute(execution, userId) {
      requireClient(execution);
      const outcome = await seams.liftSendBlock(execution.client as never, userId);
      if (outcome !== "lifted") throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return { outcome };
    },
  };

  const adjustBalance: CommandDefinition<AdjustBalanceInput> = {
    name: "account.adjust_balance",
    title: "Adjust letter balance",
    action: "account.adjust_balance",
    targetType: "user",
    transactional: true,
    verb: (input) => (input.direction === "add" ? "ADD-LETTERS" : "REMOVE-LETTERS"),
    parseInput(fields) {
      const letters = Number(fields.get("letters"));
      const direction = fields.get("direction");
      if (!Number.isInteger(letters) || letters < 1 || letters > 500 || (direction !== "add" && direction !== "remove")) {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return { letters, direction };
    },
    async preview(client, userId, input) {
      const account = await readAccountVersion(client, userId);
      if (!account) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      const credits = input.letters * CREDITS_PER_LETTER;
      if (input.direction === "remove" && (account.ledgerAvailable < credits || account.credits < credits)) {
        throw new AdminFoundationError("ADMIN_INVALID_STATE");
      }
      const after = input.direction === "add" ? account.credits + credits : account.credits - credits;
      return {
        targetId: account.userId,
        summary: {
          direction: input.direction,
          letters: input.letters,
          credits,
          creditsBefore: account.credits,
          ledgerAvailableBefore: account.ledgerAvailable,
          creditsAfter: after,
        },
        expectedVersion: account.updatedAt.toISOString(),
        display: [
          ["Account", account.userId],
          ["Balance now", `${account.credits} credits (${account.credits / CREDITS_PER_LETTER} letters); ledger spendable ${account.ledgerAvailable}`],
          ["Change", `${input.direction === "add" ? "+" : "−"}${input.letters} letters (${credits} credits)`],
          ["Balance after", `${after} credits (${after / CREDITS_PER_LETTER} letters)`],
        ],
        warnings:
          input.direction === "add"
            ? ["Added letters never expire and count as an adjustment, not a purchase: they do not affect tier or refunds."]
            : ["Letters are removed from the soonest-expiring lots first, the way sending would consume them."],
      };
    },
    async execute(execution, userId, input) {
      requireClient(execution);
      const signed = (input.direction === "add" ? 1 : -1) * input.letters * CREDITS_PER_LETTER;
      try {
        const result = await seams.adjustCreditsWithClient(
          execution.client as never,
          userId,
          signed,
          `Operator adjustment: ${execution.reason}`,
        );
        return { creditsAfter: result.user.credits, transactionId: result.transaction.transaction_id };
      } catch (error) {
        throw mapDomainError(error);
      }
    },
  };

  const grantImages: CommandDefinition<GrantImagesInput> = {
    name: "account.grant_images",
    title: "Grant image generations",
    action: "account.grant_images",
    targetType: "user",
    transactional: true,
    verb: () => "GRANT-IMAGES",
    parseInput(fields) {
      const quantity = Number(fields.get("quantity"));
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return { quantity };
    },
    async preview(client, userId, input) {
      const account = await readAccountVersion(client, userId);
      if (!account) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      const quota = await readImageQuota(client, userId);
      return {
        targetId: account.userId,
        summary: {
          quantity: input.quantity,
          allowanceBefore: quota.allowance,
          remainingBefore: quota.remaining,
        },
        expectedVersion: account.updatedAt.toISOString(),
        display: [
          ["Account", account.userId],
          ["Images now", `${quota.remaining} remaining of ${quota.allowance}`],
          ["Grant", `${input.quantity} generations, valid one year`],
        ],
        warnings: ["A compensation grant, recorded as operator_grant with the command id; replaying the command cannot grant twice."],
      };
    },
    async execute(execution, userId, input) {
      requireClient(execution);
      const entitlement = await seams.grantOperatorImageEntitlement(execution.client as never, {
        userId,
        quantity: input.quantity,
        reference: `admin:${execution.commandId}`,
      });
      return { entitlementId: entitlement?.entitlement_id ?? null, granted: entitlement !== null };
    },
  };

  const releaseQuarantine: CommandDefinition<Record<string, never>> = {
    name: "order.release_quarantine",
    title: "Release amount-mismatch quarantine",
    action: "order.release_quarantine",
    targetType: "order",
    transactional: true,
    verb: () => "RELEASE",
    parseInput: () => ({}),
    async preview(client, orderId) {
      const order = await readOrderVersion(client, orderId);
      if (!order) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (order.lastErrorCode !== "PAYMENT_AMOUNT_MISMATCH") throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return {
        targetId: order.orderId,
        summary: { userId: order.userId, status: order.status, amountCents: order.amountCents, lastErrorCode: order.lastErrorCode },
        expectedVersion: order.updatedAt.toISOString(),
        display: [
          ["Order", order.orderId],
          ["Account", order.userId],
          ["Status", order.status],
          ["Quarantine", order.lastErrorCode],
        ],
        warnings: [
          "Releasing lets the hourly maintenance run act on the order: a refund_pending order will be refunded on the next sweep.",
          "If the money should stay, refund deliberately instead, or leave the quarantine in place.",
        ],
      };
    },
    async execute(execution, orderId) {
      requireClient(execution);
      const outcome = await seams.releaseAmountMismatchQuarantine(execution.client as never, orderId, execution.reason);
      if (outcome !== "released") throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return { outcome };
    },
  };

  return { unblockSends, adjustBalance, grantImages, releaseQuarantine };
}

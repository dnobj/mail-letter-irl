import { readAccountErased } from "../../services/accountErasureService.js";
import { giftOperatorGenerationsRemaining } from "../../config/giftLetters.js";
import { normalizeGiftCode } from "../../services/giftCodes.js";
import { grantGiftLettersWithClient } from "../../services/giftLetterService.js";
import type { AdminSqlClient } from "../database.js";
import { AdminFoundationError } from "../errors.js";
import { readGiftCode } from "../queries/gifts.js";
import { readCampaignByCode } from "../queries/promos.js";
import { type CommandDefinition } from "./runner.js";

/**
 * Operator gift commands (docs/gift-letters.md): seeding an account with gift
 * letters, and voiding a printed code. Seeding is how press and influencer
 * letters go out; binding them to a seed campaign makes each print that
 * campaign's multi-use code instead of a single-use chain code.
 */

export interface GiftCommandSeams {
  grantGiftLettersWithClient: typeof grantGiftLettersWithClient;
  readAccountErased: typeof readAccountErased;
}

export interface GrantGiftsInput {
  quantity: number;
  generationsRemaining: number;
  cardCampaignCode: string | null;
}

async function readAccount(client: AdminSqlClient, userId: string): Promise<{ userId: string; updatedAt: Date } | null> {
  const result = await client.query<{ user_id: string; updated_at: Date }>(
    "SELECT user_id, updated_at FROM users WHERE user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  return row ? { userId: row.user_id, updatedAt: row.updated_at } : null;
}

async function countAvailable(client: AdminSqlClient, userId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM gift_letters
      WHERE user_id = $1 AND status = 'available' AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function seedCampaign(client: AdminSqlClient, code: string) {
  const campaign = await readCampaignByCode(client, code);
  // Only a seed campaign may be printed on a gift letter: an ordinary promo
  // code on a card would promise the recipient a gift it does not grant.
  if (!campaign || campaign.giftGenerationsRemaining === null) {
    throw new AdminFoundationError("ADMIN_INVALID_STATE");
  }
  return campaign;
}

function integerIn(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || !/^\d{1,4}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : null;
}

export function createGiftCommands(overrides: Partial<GiftCommandSeams> = {}) {
  const seams: GiftCommandSeams = { grantGiftLettersWithClient, readAccountErased, ...overrides };

  const grant: CommandDefinition<GrantGiftsInput> = {
    name: "gift.grant",
    title: "Grant gift letters",
    action: "gift.grant",
    targetType: "user",
    transactional: true,
    verb: () => "GRANT-GIFTS",
    parseInput(fields) {
      const quantity = integerIn(fields.get("quantity"), 1, 50);
      const generationsRaw = (fields.get("generationsRemaining") ?? "").trim();
      const generationsRemaining =
        generationsRaw === "" ? giftOperatorGenerationsRemaining() : integerIn(generationsRaw, 0, 20);
      const codeRaw = (fields.get("cardCampaignCode") ?? "").trim().toUpperCase();
      if (
        quantity === null ||
        generationsRemaining === null ||
        (codeRaw !== "" && !/^[A-Z0-9][A-Z0-9_-]{2,49}$/.test(codeRaw))
      ) {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return { quantity, generationsRemaining, cardCampaignCode: codeRaw || null };
    },
    async preview(client, userId, input) {
      const account = await readAccount(client, userId);
      if (!account) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      // A tombstone (#289) is given nothing (#446 review).
      if (await seams.readAccountErased(client, userId)) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      const campaign = input.cardCampaignCode ? await seedCampaign(client, input.cardCampaignCode) : null;
      const available = await countAvailable(client, userId);
      const bound = campaign
        ? `each letter prints ${campaign.code}, capped by that campaign (${campaign.maxTotalRedemptions ?? "no cap"} claims)`
        : `at most ${input.quantity * input.generationsRemaining} further free letters descend from these`;
      return {
        targetId: account.userId,
        summary: { ...input, availableBefore: available },
        expectedVersion: account.updatedAt.toISOString(),
        display: [
          ["Account", account.userId],
          ["Gift letters now", String(available)],
          ["Grant", `${input.quantity} gift ${input.quantity === 1 ? "letter" : "letters"}`],
          ["Card", campaign ? `seed code ${campaign.code}` : input.generationsRemaining > 0 ? "single-use chain code" : "plain Letter IRL card"],
          ["Budget per letter", String(input.generationsRemaining)],
          ["Cost bound", bound],
        ],
        warnings: [
          "Each gift letter is a free send that Letter IRL pays postage for. Recorded as an operator grant with the command id; replaying the command cannot grant twice.",
        ],
      };
    },
    async execute(execution, userId, input) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      const campaign = input.cardCampaignCode
        ? await seedCampaign(execution.client as unknown as AdminSqlClient, input.cardCampaignCode)
        : null;
      const granted = await seams.grantGiftLettersWithClient(execution.client, {
        userId,
        quantity: input.quantity,
        generationsRemaining: input.generationsRemaining,
        source: "operator",
        sourceReferenceId: execution.idempotencyKey,
        cardCampaignId: campaign?.campaignId ?? null,
      });
      return { granted: granted.length };
    },
  };

  const voidCode: CommandDefinition<Record<string, never>> = {
    name: "gift.void_code",
    title: "Void a gift code",
    action: "gift.void_code",
    targetType: "gift_code",
    transactional: true,
    verb: () => "VOID-CODE",
    parseInput: () => ({}),
    async preview(client, target) {
      const code = normalizeGiftCode(target);
      if (!code) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      const view = await readGiftCode(client, code);
      if (!view) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (view.status !== "issued") throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return {
        targetId: code,
        summary: { code, status: view.status, issuedToUserId: view.issuedToUserId },
        display: [
          ["Code", code],
          ["Issued to", view.issuedToUserId],
          ["Printed on letter", view.letterId],
          ["Would grant", `a gift letter with budget ${view.grantsGenerationsRemaining}`],
          ["Expires", view.expiresAt.toISOString()],
        ],
        warnings: ["The recipient holding this code will be told it is no longer valid. This cannot be undone."],
      };
    },
    async execute(execution, code) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      const result = await execution.client.query<{ code: string }>(
        `UPDATE gift_codes SET status = 'void', voided_at = NOW(), void_reason = 'operator'
          WHERE code = $1 AND status = 'issued'
          RETURNING code`,
        [code],
      );
      if (!result.rows[0]) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return { code, status: "void" };
    },
  };

  return { grant, voidCode };
}

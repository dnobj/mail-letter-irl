import { giftOperatorGenerationsRemaining } from "../../config/giftLetters.js";
import { normalizeGiftCode } from "../../services/giftCodes.js";
import { grantGiftLettersWithClient, seedCodeHold, type SeedCodeHold } from "../../services/giftLetterService.js";
import type { AdminSqlClient } from "../database.js";
import { AdminFoundationError } from "../errors.js";
import { readGiftCode } from "../queries/gifts.js";
import { readCampaignByCode, type CampaignView } from "../queries/promos.js";
import { type CommandDefinition } from "./runner.js";

/**
 * Operator gift commands (docs/gift-letters.md): seeding an account with gift
 * letters, and voiding a printed code. Seeding is how press and influencer
 * letters go out; binding them to a seed campaign makes each print that
 * campaign's multi-use code instead of a single-use chain code.
 */

export interface GiftCommandSeams {
  grantGiftLettersWithClient: typeof grantGiftLettersWithClient;
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

const NOT_LIVE: Record<string, string> = {
  draft: "is still a draft",
  paused: "is paused",
  ended: "has ended",
  expired: "has expired",
};

const HELD_BACK: Record<SeedCodeHold, (campaign: CampaignView) => string> = {
  not_seed: () => "is not a seed campaign",
  not_live: (campaign) => NOT_LIVE[campaign.status] ?? `is ${campaign.status}`,
  not_started: () => "has not started yet",
  ended: () => "is past its end date",
  at_cap: (campaign) =>
    `has been claimed as many times as it allows (${campaign.currentRedemptions} of ${campaign.maxTotalRedemptions})`,
};

/**
 * Why a letter bound to this campaign and sent now would not print its code,
 * or null when it would. The send decides with the same rule, so the preview
 * cannot promise a card the print does not draw.
 */
function codeHeldBack(campaign: CampaignView): string | null {
  const hold = seedCodeHold({
    campaign_id: campaign.campaignId,
    code: campaign.code,
    status: campaign.status,
    starts_at: campaign.startsAt,
    ends_at: campaign.endsAt,
    max_total_redemptions: campaign.maxTotalRedemptions,
    current_redemptions: campaign.currentRedemptions,
    gift_generations_remaining: campaign.giftGenerationsRemaining,
  });
  return hold === null ? null : HELD_BACK[hold](campaign);
}

function integerIn(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || !/^\d{1,4}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : null;
}

export function createGiftCommands(overrides: Partial<GiftCommandSeams> = {}) {
  const seams: GiftCommandSeams = { grantGiftLettersWithClient, ...overrides };

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
      const campaign = input.cardCampaignCode ? await seedCampaign(client, input.cardCampaignCode) : null;
      const available = await countAvailable(client, userId);
      // Each letter's card is decided when it is sent. A campaign that is not
      // live, or is at its cap (#435), does not print its code, so a letter
      // sent then prints its own card; say so before granting.
      const heldBack = campaign ? codeHeldBack(campaign) : null;
      const ownCard = input.generationsRemaining > 0 ? "a new single-use code" : "the plain Letter IRL card";
      const card = campaign
        ? heldBack === null
          ? `seed code ${campaign.code}`
          : `seed code ${campaign.code}, not printing now: ${ownCard} instead`
        : input.generationsRemaining > 0
          ? "single-use chain code"
          : "plain Letter IRL card";
      const cap =
        campaign === null || campaign.maxTotalRedemptions === null ? "no cap" : `${campaign.maxTotalRedemptions} claims`;
      const bound = campaign
        ? `each letter prints ${campaign.code}, capped by that campaign (${cap}), or its own card while that code does not print (at most ${input.generationsRemaining} further free letters each)`
        : `at most ${input.quantity * input.generationsRemaining} further free letters descend from these`;
      return {
        targetId: account.userId,
        summary: { ...input, availableBefore: available },
        expectedVersion: account.updatedAt.toISOString(),
        display: [
          ["Account", account.userId],
          ["Gift letters now", String(available)],
          ["Grant", `${input.quantity} gift ${input.quantity === 1 ? "letter" : "letters"}`],
          ["Card", card],
          ["Budget per letter", String(input.generationsRemaining)],
          ["Cost bound", bound],
        ],
        warnings: [
          "Each gift letter is a free send that Letter IRL pays postage for. Recorded as an operator grant with the command id; replaying the command cannot grant twice.",
          ...(campaign && heldBack !== null
            ? [`${campaign.code} ${heldBack}, so a letter bound to it and sent now prints its own card instead: ${ownCard}.`]
            : []),
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

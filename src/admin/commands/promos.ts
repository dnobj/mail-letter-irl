import {
  PROMO_STATUS_TRANSITIONS,
  createCampaignWithClient,
  deleteCampaignWithClient,
  transitionCampaignStatusWithClient,
} from "../../services/promoService.js";
import type { PromoCampaignStatus } from "../../services/types.js";
import { AdminFoundationError } from "../errors.js";
import { readCampaign, readCampaignByCode } from "../queries/promos.js";
import { type CommandDefinition } from "./runner.js";

export interface PromoCommandSeams {
  createCampaignWithClient: typeof createCampaignWithClient;
  transitionCampaignStatusWithClient: typeof transitionCampaignStatusWithClient;
  deleteCampaignWithClient: typeof deleteCampaignWithClient;
}

export interface CreatePromoInput {
  code: string;
  name: string;
  description: string | null;
  creditsAmount: number;
  expirationDays: number;
  maxTotalRedemptions: number | null;
  maxPerUser: number;
  requiresNewUser: boolean;
  endsAt: string | null;
}

const STATUSES: PromoCampaignStatus[] = ["draft", "active", "paused", "ended", "expired"];

function integerIn(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || value.trim() === "" || !/^-?\d{1,7}$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : null;
}

function domainError(error: unknown): AdminFoundationError {
  const message = error instanceof Error ? error.message : "";
  if (message === "not_found") return new AdminFoundationError("ADMIN_NOT_FOUND");
  if (message === "invalid_state") return new AdminFoundationError("ADMIN_INVALID_STATE");
  if (message === "stale") return new AdminFoundationError("ADMIN_STALE_PREVIEW");
  return new AdminFoundationError("ADMIN_INTERNAL_ERROR");
}

export function createPromoCommands(overrides: Partial<PromoCommandSeams> = {}) {
  const seams: PromoCommandSeams = {
    createCampaignWithClient,
    transitionCampaignStatusWithClient,
    deleteCampaignWithClient,
    ...overrides,
  };

  const create: CommandDefinition<CreatePromoInput> = {
    name: "promo.create",
    title: "Create promo campaign",
    action: "promo.create",
    targetType: "promo_campaign",
    transactional: true,
    verb: () => "CREATE-PROMO",
    parseInput(fields) {
      const code = (fields.get("code") ?? "").trim().toUpperCase();
      const name = (fields.get("name") ?? "").trim();
      const description = (fields.get("description") ?? "").trim();
      const creditsAmount = integerIn(fields.get("creditsAmount"), 0, 1000);
      const expirationDays = integerIn(fields.get("expirationDays") || "90", 1, 3650);
      const maxTotalRaw = (fields.get("maxTotalRedemptions") ?? "").trim();
      const maxTotalRedemptions = maxTotalRaw === "" ? null : integerIn(maxTotalRaw, 1, 100_000);
      const maxPerUser = integerIn(fields.get("maxPerUser") || "1", 1, 10);
      const endsAtRaw = (fields.get("endsAt") ?? "").trim();
      const endsAt = endsAtRaw === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(endsAtRaw) && !Number.isNaN(Date.parse(endsAtRaw)) ? endsAtRaw : undefined;
      if (
        !/^[A-Z0-9][A-Z0-9_-]{2,49}$/.test(code) ||
        name.length < 1 ||
        name.length > 255 ||
        description.length > 2000 ||
        creditsAmount === null ||
        expirationDays === null ||
        (maxTotalRaw !== "" && maxTotalRedemptions === null) ||
        maxPerUser === null ||
        endsAt === undefined
      ) {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return {
        code,
        name,
        description: description || null,
        creditsAmount,
        expirationDays,
        maxTotalRedemptions,
        maxPerUser,
        requiresNewUser: fields.get("requiresNewUser") === "on" || fields.get("requiresNewUser") === "true",
        endsAt,
      };
    },
    async preview(client, targetId, input) {
      if (targetId !== input.code) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      const existing = await readCampaignByCode(client, input.code);
      if (existing) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return {
        targetId: input.code,
        summary: { ...input },
        display: [
          ["Code", input.code],
          ["Name", input.name],
          ["Credits per redemption", `${input.creditsAmount} (${input.creditsAmount / 2} letters)`],
          ["Credits expire", `${input.expirationDays} days after redemption`],
          ["Total redemptions", input.maxTotalRedemptions === null ? "unlimited" : String(input.maxTotalRedemptions)],
          ["Per user", String(input.maxPerUser)],
          ["New users only", input.requiresNewUser ? "yes" : "no"],
          ["Ends", input.endsAt ?? "no end date"],
        ],
        warnings: ["Created as a draft; activate it with a second command once the details are checked."],
      };
    },
    async execute(execution, _targetId, input) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      const campaign = await seams.createCampaignWithClient(execution.client, {
        code: input.code,
        name: input.name,
        description: input.description ?? undefined,
        creditsAmount: input.creditsAmount,
        expirationPolicy: "days_from_activation",
        expirationDays: input.expirationDays,
        maxTotalRedemptions: input.maxTotalRedemptions ?? undefined,
        maxPerUser: input.maxPerUser,
        endsAt: input.endsAt ? new Date(`${input.endsAt}T23:59:59.000Z`) : undefined,
        requiresNewUser: input.requiresNewUser,
        createdBy: execution.actorId,
      });
      return { campaignId: campaign.campaign_id, code: campaign.code, status: campaign.status };
    },
  };

  const transition: CommandDefinition<{ status: PromoCampaignStatus }> = {
    name: "promo.transition",
    title: "Change promo status",
    action: "promo.transition",
    targetType: "promo_campaign",
    transactional: true,
    verb: (input) => input.status.toUpperCase(),
    parseInput(fields) {
      const status = fields.get("status") as PromoCampaignStatus | undefined;
      if (!status || !STATUSES.includes(status) || status === "expired" || status === "draft") {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return { status };
    },
    async preview(client, campaignId, input) {
      const campaign = await readCampaign(client, campaignId);
      if (!campaign) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (!PROMO_STATUS_TRANSITIONS[campaign.status as PromoCampaignStatus]?.includes(input.status)) {
        throw new AdminFoundationError("ADMIN_INVALID_STATE");
      }
      return {
        targetId: campaign.campaignId,
        summary: { code: campaign.code, fromStatus: campaign.status, toStatus: input.status, redemptions: campaign.currentRedemptions },
        expectedVersion: campaign.updatedAt.toISOString(),
        display: [
          ["Campaign", `${campaign.code} (${campaign.name})`],
          ["From", campaign.status],
          ["To", input.status],
          ["Redemptions so far", String(campaign.currentRedemptions)],
        ],
        warnings: input.status === "ended" ? ["Ended is final: an ended campaign cannot be reactivated."] : [],
      };
    },
    async execute(execution, campaignId, input, preview) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      try {
        const campaign = await seams.transitionCampaignStatusWithClient(execution.client, {
          campaignId,
          status: input.status,
          expectedUpdatedAt: preview.expectedVersion ?? "",
        });
        return { status: campaign.status };
      } catch (error) {
        throw domainError(error);
      }
    },
  };

  const remove: CommandDefinition<Record<string, never>> = {
    name: "promo.delete",
    title: "Delete promo campaign",
    action: "promo.delete",
    targetType: "promo_campaign",
    transactional: true,
    verb: () => "DELETE-PROMO",
    parseInput: () => ({}),
    async preview(client, campaignId) {
      const campaign = await readCampaign(client, campaignId);
      if (!campaign) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (campaign.currentRedemptions > 0) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return {
        targetId: campaign.campaignId,
        summary: { code: campaign.code, status: campaign.status, redemptions: campaign.currentRedemptions },
        expectedVersion: campaign.updatedAt.toISOString(),
        display: [
          ["Campaign", `${campaign.code} (${campaign.name})`],
          ["Status", campaign.status],
          ["Redemptions", String(campaign.currentRedemptions)],
        ],
        warnings: ["Deletion is permanent. A campaign that has been redeemed is refused; end it instead."],
      };
    },
    async execute(execution, campaignId) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      try {
        await seams.deleteCampaignWithClient(execution.client, campaignId);
        return { deleted: true };
      } catch (error) {
        throw domainError(error);
      }
    },
  };

  return { create, transition, remove };
}

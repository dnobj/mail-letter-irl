import { listProviders } from "../../services/providers/index.js";
import { syncLetterStatuses } from "../../services/statusSyncService.js";
import { setTierOverride } from "../../services/operatorAccountService.js";
import { USER_TIERS, type UserTier } from "../../services/types.js";
import { AdminFoundationError } from "../errors.js";
import { readRoutingRow } from "../queries/ops.js";
import { mapDomainError, type CommandDefinition } from "./runner.js";

/**
 * Slice-5 operations: tier override, provider routing validated against the
 * runtime registry, and a provider status sync run (the only command here
 * that talks to a provider; it is read-mostly and idempotent by nature).
 */

export interface OpsCommandSeams {
  setTierOverride: typeof setTierOverride;
  listProviders: typeof listProviders;
  syncLetterStatuses: typeof syncLetterStatuses;
}

const MAIL_TYPES = ["text_only_letter", "header_image_letter", "inline_image_letter", "postcard"] as const;

export interface SetTierInput {
  tier: UserTier | "clear";
}

export interface RoutingInput {
  provider: string;
  enabled: boolean;
}

export interface StatusSyncInput {
  dryRun: boolean;
  days: number;
}

interface TierRow {
  user_id: string;
  tier: string;
  tier_override: string | null;
  updated_at: Date;
}

export function createOpsCommands(overrides: Partial<OpsCommandSeams> = {}) {
  const seams: OpsCommandSeams = { setTierOverride, listProviders, syncLetterStatuses, ...overrides };

  const setTier: CommandDefinition<SetTierInput> = {
    name: "account.set_tier",
    title: "Set tier override",
    action: "account.set_tier",
    targetType: "user",
    transactional: true,
    verb: (input) => (input.tier === "clear" ? "CLEAR-TIER" : `SET-TIER-${input.tier.toUpperCase()}`),
    parseInput(fields) {
      const tier = fields.get("tier");
      if (tier !== "clear" && !USER_TIERS.includes(tier as UserTier)) {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      return { tier: tier as SetTierInput["tier"] };
    },
    async preview(client, userId, input) {
      const result = await client.query<TierRow>(
        `SELECT user_id, tier::text AS tier, tier_override::text AS tier_override, updated_at FROM users WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      const next = input.tier === "clear" ? null : input.tier;
      if (row.tier_override === next) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return {
        targetId: row.user_id,
        summary: { calculatedTier: row.tier, overrideBefore: row.tier_override, overrideAfter: next },
        expectedVersion: row.updated_at.toISOString(),
        display: [
          ["Account", row.user_id],
          ["Calculated tier", row.tier],
          ["Override now", row.tier_override ?? "none"],
          ["Override after", next ?? "none (the daily calculation applies)"],
        ],
        warnings: [
          "The API caches a user's tier for five minutes; the override takes effect on its next lookup.",
          "An override is exempt from the daily tier calculation until it is cleared.",
        ],
      };
    },
    async execute(execution, userId, input) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      await seams.setTierOverride(execution.client as never, userId, input.tier === "clear" ? null : input.tier);
      return { tierOverride: input.tier === "clear" ? null : input.tier };
    },
  };

  const routing: CommandDefinition<RoutingInput> = {
    name: "routing.update",
    title: "Change provider routing",
    action: "routing.update",
    targetType: "provider_routing",
    transactional: true,
    verb: () => "ROUTE",
    parseInput(fields) {
      const provider = (fields.get("provider") ?? "").trim().toLowerCase();
      const enabled = fields.get("enabled") === "on" || fields.get("enabled") === "true";
      if (!/^[a-z][a-z0-9_-]{1,49}$/.test(provider)) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      return { provider, enabled };
    },
    async preview(client, mailType, input) {
      if (!MAIL_TYPES.includes(mailType as (typeof MAIL_TYPES)[number])) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      const row = await readRoutingRow(client, mailType);
      if (!row) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      const registered = seams.listProviders();
      if (!registered.includes(input.provider)) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      if (row.provider === input.provider && row.enabled === input.enabled) throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return {
        targetId: mailType,
        summary: { providerBefore: row.provider, enabledBefore: row.enabled, providerAfter: input.provider, enabledAfter: input.enabled },
        expectedVersion: row.updatedAt.toISOString(),
        display: [
          ["Mail type", mailType],
          ["Now", `${row.provider} (${row.enabled ? "enabled" : "disabled"})`],
          ["After", `${input.provider} (${input.enabled ? "enabled" : "disabled"})`],
          ["Registered providers", registered.join(", ")],
        ],
        warnings: [
          "The dummy provider is refused at send time in production regardless of this table; production routing must name a live provider with its key configured.",
          "Routing changes apply to the next send; nothing in the outbox is re-routed.",
        ],
      };
    },
    async execute(execution, mailType, input, preview) {
      if (!execution.client) throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
      if (execution.environment === "production" && input.provider === "dummy") {
        throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      }
      const result = await execution.client.query(
        `UPDATE provider_routing SET provider = $1, enabled = $2, updated_by = $3, updated_at = NOW()
         WHERE mail_type = $4 AND updated_at = $5::timestamptz RETURNING mail_type`,
        [input.provider, input.enabled, execution.actorId, mailType, preview.expectedVersion],
      );
      if (result.rowCount === 0) throw new AdminFoundationError("ADMIN_STALE_PREVIEW");
      return { provider: input.provider, enabled: input.enabled };
    },
  };

  const statusSync: CommandDefinition<StatusSyncInput> = {
    name: "mail.status_sync",
    title: "Sync letter statuses from the provider",
    action: "mail.status_sync",
    targetType: "provider",
    transactional: false,
    verb: (input) => (input.dryRun ? "SYNC-DRY-RUN" : "SYNC"),
    parseInput(fields) {
      const days = Number(fields.get("days") ?? "30");
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      return { dryRun: fields.get("dryRun") !== "off", days };
    },
    async preview(_client, target, input) {
      if (target !== "letters") throw new AdminFoundationError("ADMIN_NOT_FOUND");
      return {
        targetId: "letters",
        summary: { dryRun: input.dryRun, days: input.days },
        display: [
          ["Scope", `letters created in the last ${input.days} days that are not yet terminal`],
          ["Mode", input.dryRun ? "dry run (report only)" : "apply (letter statuses and history are updated)"],
        ],
        warnings: [
          "Calls the environment's mail provider once per letter; large windows take time and count against the provider's rate limits.",
          "The hourly maintenance run already syncs every six hours; use this for an immediate check.",
        ],
      };
    },
    async execute(_execution, _target, input) {
      try {
        const result = await seams.syncLetterStatuses(input.dryRun, input.days);
        return {
          dryRun: input.dryRun,
          checked: result.checked,
          updated: result.updated,
          errors: result.errors,
          changes: result.details.slice(0, 20).map((detail) => ({
            letterId: detail.letterId,
            from: detail.oldStatus,
            to: detail.newStatus,
            error: detail.error ?? null,
          })),
        };
      } catch (error) {
        throw mapDomainError(error);
      }
    },
  };

  return { setTier, routing, statusSync };
}

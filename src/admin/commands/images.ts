import {
  resolveAmbiguousGenerationReservation,
  type AmbiguousGenerationDecision,
  type AmbiguousGenerationResolution,
} from "../../services/imageGenerationLimitService.js";
import { AdminFoundationError } from "../errors.js";
import { readReservation } from "../queries/images.js";
import { mapDomainError, type CommandDefinition } from "./runner.js";

export interface ImageCommandSeams {
  resolveAmbiguousGenerationReservation: typeof resolveAmbiguousGenerationReservation;
}

export interface ResolveReservationInput {
  decision: AmbiguousGenerationDecision;
  resolution: AmbiguousGenerationResolution;
}

/**
 * Finish an ambiguous image reservation (issue #69's operator recovery, now
 * reachable). The service locks the row, refuses anything but `ambiguous`,
 * and writes its hashed audit row; consume keeps the quota used, release
 * returns it, and customer_compensation is the release that says so.
 */
export function createImageCommands(overrides: Partial<ImageCommandSeams> = {}) {
  const seams: ImageCommandSeams = { resolveAmbiguousGenerationReservation, ...overrides };

  const resolve: CommandDefinition<ResolveReservationInput> = {
    name: "image.resolve",
    title: "Resolve ambiguous image reservation",
    action: "image.resolve",
    targetType: "image_reservation",
    transactional: false,
    verb: (input) => `RESOLVE-${input.decision.toUpperCase()}`,
    parseInput(fields) {
      const decision = fields.get("decision");
      const resolution = fields.get("resolution");
      const valid =
        (decision === "consume" && resolution === "provider_confirmed_succeeded") ||
        (decision === "release" && (resolution === "provider_confirmed_failed" || resolution === "customer_compensation"));
      if (!valid) throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
      return { decision, resolution } as ResolveReservationInput;
    },
    async preview(client, reservationId, input) {
      const reservation = await readReservation(client, reservationId);
      if (!reservation) throw new AdminFoundationError("ADMIN_NOT_FOUND");
      if (reservation.status !== "ambiguous") throw new AdminFoundationError("ADMIN_INVALID_STATE");
      return {
        targetId: reservation.reservationId,
        summary: {
          userId: reservation.userId,
          entitlementId: reservation.entitlementId,
          decision: input.decision,
          resolution: input.resolution,
          dispatchStartedAt: reservation.dispatchStartedAt?.toISOString() ?? null,
          hasProviderRequestId: reservation.hasProviderRequestId,
        },
        expectedVersion: reservation.updatedAt.toISOString(),
        display: [
          ["Reservation", reservation.reservationId],
          ["Account", reservation.userId],
          ["Dispatch started", reservation.dispatchStartedAt?.toISOString() ?? "—"],
          ["Provider request id", reservation.hasProviderRequestId ? "present" : "absent"],
          ["Current reason", reservation.resolutionReason ?? "—"],
          ["Decision", `${input.decision} (${input.resolution})`],
        ],
        warnings:
          input.decision === "consume"
            ? ["Consume keeps the generation counted against the customer's quota: use it only when the provider shows the image was produced."]
            : ["Release returns the generation to the customer's quota."],
      };
    },
    async execute(execution, reservationId, input, preview) {
      try {
        const result = await seams.resolveAmbiguousGenerationReservation({
          reservationId,
          expectedUserId: String(preview.summary.userId),
          actorId: execution.actorId,
          idempotencyKey: execution.idempotencyKey,
          decision: input.decision,
          resolution: input.resolution,
        });
        return { resultingStatus: result.resultingStatus, domainReplayed: result.replayed };
      } catch (error) {
        throw mapDomainError(error);
      }
    },
  };

  return { resolve };
}

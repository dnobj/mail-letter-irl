import { transitionCommerceAlert } from "../../services/commerceAlertService.js";
import { AdminFoundationError } from "../errors.js";
import { readAlert } from "../queries/alerts.js";
import { mapDomainError, type CommandDefinition } from "./runner.js";

export interface AlertTransitionInput {
  status: "acknowledged" | "resolved";
  resolutionCode?: string;
}

const RESOLUTION_CODE = /^[a-z][a-z0-9_]{2,79}$/;

/**
 * Acknowledge or resolve an operational alert. The domain service owns the
 * state machine, the advisory lock and the hashed audit row; this command
 * adds the preview, the typed confirmation, the run row and the panel audit.
 */
export const alertTransitionCommand: CommandDefinition<AlertTransitionInput> = {
  name: "alert.transition",
  title: "Transition alert",
  action: "alert.transition",
  targetType: "commerce_alert",
  transactional: false,
  verb: (input) => (input.status === "resolved" ? "RESOLVE" : "ACKNOWLEDGE"),
  parseInput(fields) {
    const status = fields.get("status");
    if (status !== "acknowledged" && status !== "resolved") {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    const resolutionCode = (fields.get("resolutionCode") ?? "").trim();
    if (status === "resolved" && !RESOLUTION_CODE.test(resolutionCode)) {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    return status === "resolved" ? { status, resolutionCode } : { status };
  },
  async preview(client, alertId, input) {
    if (!/^[0-9a-f-]{36}$/i.test(alertId)) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    const alert = await readAlert(client, alertId);
    if (!alert) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    if (alert.status === "resolved" || (input.status === "acknowledged" && alert.status !== "open")) {
      throw new AdminFoundationError("ADMIN_INVALID_STATE");
    }
    return {
      targetId: alert.alertId,
      summary: {
        alertType: alert.alertType,
        severity: alert.severity,
        fromStatus: alert.status,
        toStatus: input.status,
        resolutionCode: input.resolutionCode ?? null,
        orderId: alert.orderId,
      },
      expectedVersion: alert.updatedAt.toISOString(),
      display: [
        ["Alert", alert.alertId],
        ["Type", alert.alertType],
        ["Severity", alert.severity],
        ["Order", alert.orderId ?? "—"],
        ["From", alert.status],
        ["To", input.status],
        ["Resolution code", input.resolutionCode ?? "—"],
      ],
      warnings:
        input.status === "resolved"
          ? ["Resolving is final: a resolved alert cannot be reopened from the panel."]
          : [],
    };
  },
  async execute(execution, alertId, input) {
    try {
      const result = await transitionCommerceAlert({
        alertId,
        status: input.status,
        resolutionCode: input.resolutionCode,
        idempotencyKey: execution.idempotencyKey,
        actorId: execution.actorId,
      });
      return { status: input.status, domainReplayed: result.replayed };
    } catch (error) {
      throw mapDomainError(error);
    }
  },
};

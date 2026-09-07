import { createHash } from "node:crypto";

import {
  resolveAmbiguousLetterJobAsAdmin,
  retryLetterJobAsAdmin,
  type AmbiguousMailDecision,
  type AmbiguousMailResolution,
} from "../../services/letterJobService.js";
import { AdminFoundationError } from "../errors.js";
import { readJob } from "../queries/jobs.js";
import { mapDomainError, type CommandDefinition } from "./runner.js";

const PROVIDERS = ["postgrid", "dummy", "diy"] as const;
type ProviderName = (typeof PROVIDERS)[number];
const TRACKING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,254}$/;

export interface JobResolveInput {
  decision: AmbiguousMailDecision;
  providerName: ProviderName;
  providerTrackingId?: string;
}

function resolutionFor(decision: AmbiguousMailDecision): AmbiguousMailResolution {
  switch (decision) {
    case "accepted":
      return "provider_confirmed_accepted";
    case "retry":
      return "provider_confirmed_rejected_retry";
    default:
      return "provider_confirmed_rejected_refund";
  }
}

/**
 * Finish an ambiguous provider outcome with conclusive evidence. The service
 * locks order -> letter -> job, refuses compensated letters, resolves the
 * matching alert and writes its hashed audit row; the panel adds the preview
 * (which shows the job's current state), the typed confirmation and the run.
 */
export const jobResolveCommand: CommandDefinition<JobResolveInput> = {
  name: "job.resolve",
  title: "Resolve ambiguous job",
  action: "job.resolve",
  targetType: "letter_job",
  transactional: false,
  verb: (input) => `RESOLVE-${input.decision.toUpperCase()}`,
  parseInput(fields) {
    const decision = fields.get("decision");
    const providerName = fields.get("providerName");
    const tracking = (fields.get("providerTrackingId") ?? "").trim();
    if (decision !== "accepted" && decision !== "retry" && decision !== "rejected") {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    if (!PROVIDERS.includes(providerName as ProviderName)) {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    if (decision === "accepted" ? !TRACKING_ID.test(tracking) : tracking.length > 0) {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    return decision === "accepted"
      ? { decision, providerName: providerName as ProviderName, providerTrackingId: tracking }
      : { decision, providerName: providerName as ProviderName };
  },
  async preview(client, jobId, input) {
    const job = await readJob(client, jobId);
    if (!job) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    if (job.status !== "held" || job.providerOutcome !== "ambiguous" || job.letterStatus !== "held") {
      throw new AdminFoundationError("ADMIN_INVALID_STATE");
    }
    // The provider reference is evidence, not something to store in clear
    // on the audit row: the digest binds its hash.
    const trackingHash = input.providerTrackingId
      ? createHash("sha256").update(input.providerTrackingId).digest("hex")
      : null;
    return {
      targetId: job.jobId,
      summary: {
        letterId: job.letterId,
        userId: job.userId,
        decision: input.decision,
        resolution: resolutionFor(input.decision),
        providerName: input.providerName,
        providerTrackingIdHash: trackingHash,
        fundingOrderId: job.fundingOrderId,
        jobStatus: job.status,
        providerOutcome: job.providerOutcome,
      },
      expectedVersion: job.updatedAt.toISOString(),
      display: [
        ["Job", job.jobId],
        ["Letter", job.letterId],
        ["Account", job.userId],
        ["Funding order", job.fundingOrderId ?? "prepaid balance"],
        ["Current", `${job.status} / ${job.providerOutcome} (held: ${job.holdReason ?? "—"})`],
        ["Decision", input.decision],
        ["Resolution", resolutionFor(input.decision)],
        ["Provider", input.providerName],
        ["Provider reference", input.providerTrackingId ? "present (hashed in the audit)" : "none"],
      ],
      warnings:
        input.decision === "accepted"
          ? ["Accepted marks the letter as mailed with this reference. Only use evidence from the provider dashboard."]
          : input.decision === "retry"
            ? ["Retry resends the letter through the outbox; the customer is not charged again."]
            : ["Rejected fails the letter; a prepaid letter's credits return through the failed-send path, and a Pay & Send order moves to refund."],
    };
  },
  async execute(execution, jobId, input, preview) {
    try {
      const result = await resolveAmbiguousLetterJobAsAdmin({
        jobId,
        expectedUserId: String(preview.summary.userId),
        actorId: execution.actorId,
        idempotencyKey: execution.idempotencyKey,
        decision: input.decision,
        resolution: resolutionFor(input.decision),
        providerName: input.providerName,
        providerTrackingId: input.providerTrackingId,
      });
      return {
        decision: result.decision,
        resolution: result.resolution,
        jobStatus: result.jobStatus,
        letterStatus: result.letterStatus,
        orderStatus: result.orderStatus,
        domainReplayed: result.replayed,
      };
    } catch (error) {
      throw mapDomainError(error);
    }
  },
};

/**
 * Retry a job the provider definitely rejected. The service refuses anything
 * but failed/definite_failure with a failed letter, and any letter whose
 * pack has already been returned. The operator's reason travels with the
 * confirmation and becomes the service's reason.
 */
export const jobRetryCommand: CommandDefinition<Record<string, never>> = {
  name: "job.retry",
  title: "Retry failed job",
  action: "job.retry",
  targetType: "letter_job",
  transactional: false,
  verb: () => "RETRY",
  parseInput() {
    return {};
  },
  async preview(client, jobId) {
    const job = await readJob(client, jobId);
    if (!job) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    if (
      job.status !== "failed" ||
      job.providerOutcome !== "definite_failure" ||
      job.letterStatus !== "failed" ||
      job.operatorResolution
    ) {
      throw new AdminFoundationError("ADMIN_INVALID_STATE");
    }
    return {
      targetId: job.jobId,
      summary: {
        letterId: job.letterId,
        userId: job.userId,
        fundingOrderId: job.fundingOrderId,
        attempts: job.attempts,
        jobStatus: job.status,
        providerOutcome: job.providerOutcome,
      },
      expectedVersion: job.updatedAt.toISOString(),
      display: [
        ["Job", job.jobId],
        ["Letter", job.letterId],
        ["Account", job.userId],
        ["Funding order", job.fundingOrderId ?? "prepaid balance"],
        ["Attempts so far", `${job.attempts} of ${job.maxAttempts}`],
        ["Last error", job.lastError ?? "—"],
      ],
      warnings: [
        "The letter is queued again and dispatched by the next maintenance run with the same provider idempotency key.",
        "The reason you give on this page is recorded with the retry.",
      ],
    };
  },
  async execute(execution, jobId, _input, preview) {
    if (execution.reason.length < 8 || execution.reason.length > 500) {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    try {
      const result = await retryLetterJobAsAdmin({
        jobId,
        expectedUserId: String(preview.summary.userId),
        actorId: execution.actorId,
        reason: execution.reason,
        idempotencyKey: execution.idempotencyKey,
      });
      return { jobStatus: "pending", domainReplayed: result.replayed };
    } catch (error) {
      throw mapDomainError(error);
    }
  },
};

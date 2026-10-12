import { createHash } from "node:crypto";

import {
  cancelLeftLetterJobAsAdmin,
  releaseHeldLetterJobAsAdmin,
  resolveAmbiguousLetterJobAsAdmin,
  retryLetterJobAsAdmin,
  type AmbiguousMailDecision,
  type AmbiguousMailResolution,
} from "../../services/letterJobService.js";
import { AdminFoundationError } from "../errors.js";
import { isCancellableLeftJob, isFundingHeldMailJob, isHeldMailJob, readJob } from "../queries/jobs.js";
import { providerPrintsRenderedPdf, providerSellsExtraServices } from "../../services/providers/extraServices.js";
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
          ? [
              "Accepted marks the letter as mailed with this reference. Only use evidence from the provider dashboard.",
              // Certified mail (#625): the service is checked under the lock, when the letter is read there.
              ...(providerSellsExtraServices(input.providerName)
                ? []
                : ["Manual fulfilment cannot send certified mail: accepting a certified letter with this provider is refused."]),
              // Mail our renderer drew (#698): checked under the lock too.
              ...(providerPrintsRenderedPdf(input.providerName)
                ? []
                : ["This provider does not print what our renderer drew: accepting a letter previewed on our renderer (all mail while LETTER_IRL_PRINT_RENDERER=pdf) is refused."]),
            ]
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

/**
 * Send held mail now (#535): a letter held to arrive by a date becomes due at
 * once, and the next hourly maintenance run sends it instead of waiting for
 * its mail date. The service refuses anything but mail still held. The
 * operator's reason travels with the confirmation and becomes the service's
 * reason, recorded hashed in the operator audit.
 */
export const jobDispatchNowCommand: CommandDefinition<Record<string, never>> = {
  name: "job.dispatch_now",
  title: "Send held mail now",
  action: "job.dispatch_now",
  targetType: "letter_job",
  transactional: false,
  verb: () => "DISPATCH",
  parseInput() {
    return {};
  },
  async preview(client, jobId) {
    const job = await readJob(client, jobId);
    if (!job) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    // Held mail before its date, or mail held for its funding (#696), due or not.
    const fundingHeld = isFundingHeldMailJob(job);
    if (!fundingHeld && (!isHeldMailJob(job) || !job.heldUntil)) throw new AdminFoundationError("ADMIN_INVALID_STATE");
    return {
      targetId: job.jobId,
      summary: {
        letterId: job.letterId,
        userId: job.userId,
        fundingOrderId: job.fundingOrderId,
        heldUntil: job.heldUntil ? job.heldUntil.toISOString() : null,
        jobStatus: job.status,
        ...(fundingHeld ? { fundingHold: job.holdReason } : {}),
      },
      expectedVersion: job.updatedAt.toISOString(),
      display: [
        ["Job", job.jobId],
        ["Letter", job.letterId],
        ["Account", job.userId],
        [
          "Funding",
          job.fundingOrderId
            ? `Pay & Send order ${job.fundingOrderId}`
            : job.fundingType === "gift_letter"
              ? "a gift letter"
              : "prepaid balance",
        ],
        ...(job.heldUntil
          ? [["Held until", `${job.heldUntil.toISOString()} (09:00 New York time on its mail date)`] as [string, string]]
          : []),
        ...(fundingHeld
          ? [["Held because", job.holdReason === "funding_disputed" ? "the pack that paid for it was lost to a dispute" : "the pack that paid for it was refunded in full"] as [string, string]]
          : []),
      ],
      warnings: [
        ...(fundingHeld
          ? [
              "The money that paid for this letter went back. Sending it prints a letter nobody is paying for: release it only when the dispute is won, or you choose to.",
              "If the account's sending is blocked, the letter still waits until it is unblocked.",
            ]
          : []),
        ...(fundingHeld
          ? ["It goes to the printer on its mail date, or at the next hourly run if that date has passed or it has none."]
          : [
              "The letter goes to the printer at the next hourly maintenance run instead of on its mail date, so it may arrive well before the date the customer chose.",
              "The customer can still cancel it until that run takes it.",
            ]),
        "The reason you give on this page is recorded with the release.",
      ],
    };
  },
  async execute(execution, jobId, _input, preview) {
    if (execution.reason.length < 8 || execution.reason.length > 500) {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    try {
      const result = await releaseHeldLetterJobAsAdmin({
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

/**
 * Cancel mail left for the operator (#696, decision D2): a prepaid or gift letter held
 * because the pack that paid for it was refunded in full or lost to a dispute, or of an
 * account whose sending is blocked. What paid for it goes back as a failed send's would:
 * nothing from a revoked pack, no gift from a refunded or disputed purchase. A Pay & Send
 * letter is cancelled by its order's refund instead. The service checks it all again under
 * its locks.
 */
export const jobCancelHeldCommand: CommandDefinition<Record<string, never>> = {
  name: "job.cancel_held",
  title: "Cancel mail left for the operator",
  action: "job.cancel_held",
  targetType: "letter_job",
  transactional: false,
  verb: () => "CANCEL",
  parseInput() {
    return {};
  },
  async preview(client, jobId) {
    const job = await readJob(client, jobId);
    if (!job) throw new AdminFoundationError("ADMIN_NOT_FOUND");
    if (!isCancellableLeftJob(job)) throw new AdminFoundationError("ADMIN_INVALID_STATE");
    const why =
      job.holdReason === "funding_disputed"
        ? "the pack that paid for it was lost to a dispute"
        : job.holdReason === "funding_reversed"
          ? "the pack that paid for it was refunded in full"
          : "the account's sending is blocked";
    return {
      targetId: job.jobId,
      summary: { letterId: job.letterId, userId: job.userId, fundingType: job.fundingType, jobStatus: job.status },
      expectedVersion: job.updatedAt.toISOString(),
      display: [
        ["Job", job.jobId],
        ["Letter", job.letterId],
        ["Account", job.userId],
        ["Funding", job.fundingType === "gift_letter" ? "a gift letter" : "prepaid balance"],
        ["Held because", why],
      ],
      warnings: [
        "The letter is cancelled and never printed.",
        "What paid for it goes back only if it can: nothing from a pack refunded or lost to a dispute, and no gift from a refunded or disputed purchase.",
        "The reason you give on this page is recorded with the cancel.",
      ],
    };
  },
  async execute(execution, jobId, _input, preview) {
    if (execution.reason.length < 8 || execution.reason.length > 500) {
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    try {
      const result = await cancelLeftLetterJobAsAdmin({
        jobId,
        expectedUserId: String(preview.summary.userId),
        actorId: execution.actorId,
        reason: execution.reason,
        idempotencyKey: execution.idempotencyKey,
      });
      return { jobStatus: "cancelled", domainReplayed: result.replayed };
    } catch (error) {
      throw mapDomainError(error);
    }
  },
};

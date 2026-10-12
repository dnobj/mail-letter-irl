import type { AdminSqlClient } from "../database.js";
import { fundingHeldJobSql, isFundingHoldReason, isHeldMailJobState } from "../../services/heldMail.js";
import { JOB_COLUMNS, toJobDetail, type JobDetailForLetter, type JobRow } from "./accounts.js";

export interface JobView extends JobDetailForLetter {
  letterId: string;
  userId: string;
  letterStatus: string;
  mailType: string;
  fundingType: string;
  fundingOrderId: string | null;
  /** The account's sending is blocked (#696): the outbox leaves its mail. */
  accountBlocked: boolean;
}

interface JobJoinedRow extends JobRow {
  letter_id: string;
  user_id: string;
  letter_status: string;
  mail_type: string;
  funding_type: string;
  funding_order_id: string | null;
  account_blocked: boolean;
}

const JOB_JOINED_SQL = `
  SELECT ${JOB_COLUMNS},
         l.letter_id, l.user_id, l.status AS letter_status, l.mail_type::text AS mail_type,
         l.funding_type, l.funding_order_id,
         (u.sends_blocked_reason IS NOT NULL) AS account_blocked
  FROM letter_jobs j JOIN letters l ON l.letter_id = j.letter_id
  LEFT JOIN users u ON u.user_id = l.user_id
`;

/**
 * Mail still waiting for its mail date (#535): the job pending, never
 * attempted or dispatched, carrying its hold and not yet due, its letter
 * queued. The page offers job.dispatch_now only then; the service checks the
 * same again under its locks, by the database's clock.
 */
export function isHeldMailJob(job: JobView, now: number = Date.now()): boolean {
  return (
    isHeldMailJobState({ ...job, mailHoldUntil: job.heldUntil }, now) &&
    job.letterStatus === "queued" &&
    !job.operatorResolution
  );
}

/**
 * Mail the outbox leaves for the operator (#696): never dispatched, pending with an
 * attempt left, its letter queued, due or not, and held for its funding (a pack refunded in
 * full or lost to a dispute) or of an account whose sending is blocked. The service checks
 * the same again under its locks.
 */
export function isLeftForOperatorJob(job: JobView): boolean {
  return (
    job.status === "pending" &&
    job.providerOutcome === "not_dispatched" &&
    job.attempts < job.maxAttempts &&
    job.letterStatus === "queued" &&
    !job.operatorResolution &&
    (isFundingHoldReason(job.holdReason) || job.accountBlocked)
  );
}

/** Mail held for its funding (#696), which job.dispatch_now releases, due or not: a dispute can outlast its mail date. */
export function isFundingHeldMailJob(job: JobView): boolean {
  return isLeftForOperatorJob(job) && isFundingHoldReason(job.holdReason);
}

/** What job.cancel_held cancels: prepaid or gift mail left for the operator. A Pay & Send letter goes with its order's refund. */
export function isCancellableLeftJob(job: JobView): boolean {
  return isLeftForOperatorJob(job) && !job.fundingOrderId && ["prepaid_balance", "gift_letter"].includes(job.fundingType);
}

/** What job.dispatch_now may release: held mail before its date, or mail held for its funding. */
export function isReleasableMailJob(job: JobView, now: number = Date.now()): boolean {
  return isHeldMailJob(job, now) || isFundingHeldMailJob(job);
}

function toJobView(row: JobJoinedRow): JobView {
  return {
    ...toJobDetail(row),
    letterId: row.letter_id,
    userId: row.user_id,
    letterStatus: row.letter_status,
    mailType: row.mail_type,
    fundingType: row.funding_type,
    fundingOrderId: row.funding_order_id,
    accountBlocked: row.account_blocked === true,
  };
}

/**
 * Jobs that need an operator: held (ambiguous provider outcome or accepted
 * after a refund), left for the operator (#696: held for their funding, or of
 * a blocked account), failed, or processing for longer than a dispatch takes.
 */
export async function listAttentionJobs(
  client: AdminSqlClient,
  limit: number,
): Promise<JobView[]> {
  const result = await client.query<JobJoinedRow>(
    `${JOB_JOINED_SQL}
     WHERE j.status IN ('held', 'failed')
        OR (j.status = 'pending' AND ${fundingHeldJobSql("j")})
        OR (j.status = 'pending' AND j.provider_outcome = 'not_dispatched' AND u.sends_blocked_reason IS NOT NULL)
        OR (j.status = 'processing' AND j.locked_at < NOW() - INTERVAL '10 minutes')
     ORDER BY CASE j.status WHEN 'held' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END, j.updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map(toJobView);
}

export async function listRecentJobs(
  client: AdminSqlClient,
  limit: number,
): Promise<JobView[]> {
  const result = await client.query<JobJoinedRow>(
    `${JOB_JOINED_SQL} ORDER BY j.created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toJobView);
}

export async function readJob(
  client: AdminSqlClient,
  jobId: string,
): Promise<JobView | null> {
  const result = await client.query<JobJoinedRow>(
    `${JOB_JOINED_SQL} WHERE j.job_id = $1`,
    [jobId],
  );
  return result.rows[0] ? toJobView(result.rows[0]) : null;
}

export interface OutboxBacklog {
  pendingDue: number;
  pendingLater: number;
  processingStale: number;
  held: number;
  failed: number;
}

export async function readOutboxBacklog(client: AdminSqlClient): Promise<OutboxBacklog> {
  const result = await client.query<{
    pending_due: string;
    pending_later: string;
    processing_stale: string;
    held: string;
    failed: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending' AND next_attempt_at <= NOW())::text AS pending_due,
       COUNT(*) FILTER (WHERE status = 'pending' AND next_attempt_at > NOW())::text AS pending_later,
       COUNT(*) FILTER (WHERE status = 'processing' AND locked_at < NOW() - INTERVAL '10 minutes')::text AS processing_stale,
       COUNT(*) FILTER (WHERE status = 'held')::text AS held,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
     FROM letter_jobs`,
  );
  const row = result.rows[0];
  return {
    pendingDue: Number(row?.pending_due ?? 0),
    pendingLater: Number(row?.pending_later ?? 0),
    processingStale: Number(row?.processing_stale ?? 0),
    held: Number(row?.held ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

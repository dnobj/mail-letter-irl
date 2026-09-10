import type { AdminSqlClient } from "../database.js";
import { JOB_COLUMNS, toJobDetail, type JobDetailForLetter, type JobRow } from "./accounts.js";

export interface JobView extends JobDetailForLetter {
  letterId: string;
  userId: string;
  letterStatus: string;
  mailType: string;
  fundingType: string;
  fundingOrderId: string | null;
}

interface JobJoinedRow extends JobRow {
  letter_id: string;
  user_id: string;
  letter_status: string;
  mail_type: string;
  funding_type: string;
  funding_order_id: string | null;
}

const JOB_JOINED_SQL = `
  SELECT ${JOB_COLUMNS},
         l.letter_id, l.user_id, l.status AS letter_status, l.mail_type::text AS mail_type,
         l.funding_type, l.funding_order_id
  FROM letter_jobs j JOIN letters l ON l.letter_id = j.letter_id
`;

function toJobView(row: JobJoinedRow): JobView {
  return {
    ...toJobDetail(row),
    letterId: row.letter_id,
    userId: row.user_id,
    letterStatus: row.letter_status,
    mailType: row.mail_type,
    fundingType: row.funding_type,
    fundingOrderId: row.funding_order_id,
  };
}

/**
 * Jobs that need an operator: held (ambiguous provider outcome or accepted
 * after a refund), failed, or processing for longer than a dispatch takes.
 */
export async function listAttentionJobs(
  client: AdminSqlClient,
  limit: number,
): Promise<JobView[]> {
  const result = await client.query<JobJoinedRow>(
    `${JOB_JOINED_SQL}
     WHERE j.status IN ('held', 'failed')
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

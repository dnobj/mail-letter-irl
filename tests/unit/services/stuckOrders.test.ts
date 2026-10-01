/**
 * The stuck Pay & Send orders condition (#535), shared by the hourly log and
 * the admin panel's health. Its effect runs against PostgreSQL in
 * tests/integration/arriveBy.postgres.test.ts, and under the admin reader
 * role in tests/integration/adminReadModels.postgres.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { STUCK_ORDER_CONDITION } from '../../../src/services/stuckOrders.js';
import { listStuckLetters } from '../../../src/admin/queries/ops.js';

const flat = (sql: string) => sql.replace(/\s+/g, ' ');

describe('STUCK_ORDER_CONDITION', () => {
  it('flags paid, fulfilling and refunding orders after 30 minutes', () => {
    expect(flat(STUCK_ORDER_CONDITION)).toContain(
      "status IN ('paid', 'fulfillment_pending', 'refund_pending') AND updated_at < NOW() - INTERVAL '30 minutes'"
    );
  });

  it('leaves out a held letter\'s order until 90 minutes after its hold ends, reading only what the admin reader may', () => {
    const sql = flat(STUCK_ORDER_CONDITION);
    expect(sql).toContain("AND NOT ( status = 'fulfillment_pending' AND EXISTS (");
    expect(sql).toContain('held.funding_order_id = orders.order_id');
    expect(sql).toContain("held.status = 'queued'");
    expect(sql).toContain("held_job.metadata->>'heldUntil' IS NOT NULL");
    expect(sql).toContain("(held_job.metadata->>'heldUntil')::timestamptz > NOW() - INTERVAL '90 minutes'");
    // Only until it is first tried, or 90 minutes after it falls due when an
    // operator sends it before its hold ends (job.dispatch_now).
    expect(sql).toContain('AND held_job.attempts = 0');
    expect(sql).toContain("AND held_job.next_attempt_at > NOW() - INTERVAL '90 minutes'");
    // letters.mail_on is not in the admin reader's column list.
    expect(sql).not.toContain('mail_on');
  });
});

describe('the admin panel\'s stuck letters (#535)', () => {
  it('counts from sent_at, so held mail is not stuck for the weeks it waited', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await listStuckLetters(client as never, 14, 50);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(flat(sql)).toContain('COALESCE(sent_at, created_at) AS mailed_at');
    expect(flat(sql)).toContain('EXTRACT(DAY FROM NOW() - COALESCE(sent_at, created_at))::int AS days');
    expect(flat(sql)).toContain('AND COALESCE(sent_at, created_at) < NOW() - make_interval(days => $1::int)');
    expect(params).toEqual([14, 50]);
  });
});

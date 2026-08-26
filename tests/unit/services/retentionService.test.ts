import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query
}));

const {
  purgeExpiredLetterContent,
  purgePaidDraftContent,
  purgeAbandonedDraftContent,
  purgeExpiredQuarantine,
  restoreQuarantinedContent,
  runRetentionSweep,
  splitRetentionWindow
} = await import('../../../src/services/retentionService.js');

/**
 * Issue #153 - guards on a sweep that removes customer content.
 *
 * WHY THESE ASSERT WHOLE CLAUSES INCLUDING POLARITY
 * An earlier version matched loose substrings and was proven worthless by
 * mutation: the outer WHERE replaced by TRUE, NOT EXISTS inverted to EXISTS,
 * and the boundary flipped all passed. A later version fixed that for the
 * LETTERS sweep only - a review then showed the two DRAFT sweeps had no outer
 * WHERE pin, no parameter pin and no letter_jobs pin at all, so their entire
 * blast radius was unasserted on the one lane that runs without Docker.
 * Every sweep is now pinned symmetrically.
 */
function sqlFrom(call: unknown[]): string {
  return String(call[0]).replace(/\s+/g, ' ').trim();
}

describe('splitRetentionWindow (#153)', () => {
  it('splits the published period so nothing outlives it', () => {
    // The published number is the TOTAL exposure. A naive quarantine would
    // hold content for 90 + 7 days and quietly breach the promise.
    expect(splitRetentionWindow(90)).toEqual({ liveDays: 83, quarantineDays: 7 });
  });

  it('shortens the recovery window rather than overrunning a short period', () => {
    expect(splitRetentionWindow(7)).toEqual({ liveDays: 4, quarantineDays: 3 });
    expect(splitRetentionWindow(2)).toEqual({ liveDays: 1, quarantineDays: 1 });
  });

  it.each([2, 7, 30, 90, 365])('always sums back to the published %s days', total => {
    const { liveDays, quarantineDays } = splitRetentionWindow(total);
    expect(liveDays + quarantineDays).toBe(total);
    expect(liveDays).toBeGreaterThanOrEqual(1);
    expect(quarantineDays).toBeGreaterThanOrEqual(1);
  });
});

describe('retention sweep guards (#153)', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('purgeExpiredLetterContent', () => {
    it('saves content to quarantine before emptying the row', async () => {
      await purgeExpiredLetterContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      // One statement, so the save and the empty are atomic.
      expect(sql).toContain(
        'INSERT INTO redacted_content_quarantine (source_table, source_id, content, purge_after)'
      );
      expect(sql).toContain("SELECT 'letters', l.letter_id,");
      expect(sql).toContain(
        "jsonb_build_object( 'content', l.content, 'recipient', l.recipient, " +
          "'preview_html', to_jsonb(l.preview_html) )"
      );
      // The recovery window itself. Collapsing this to NOW() would make the
      // quarantine purge on its first pass, i.e. destruction with extra steps.
      expect(sql).toContain('NOW() + make_interval(days => $7::int)');
      // Re-redacting after a restore replaces the row rather than failing.
      expect(sql).toContain('ON CONFLICT (source_table, source_id) DO UPDATE');
    });

    it('bounds the UPDATE to the due CTE and to the content columns', async () => {
      await purgeExpiredLetterContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        "UPDATE letters SET content = '{}'::jsonb, recipient = '{}'::jsonb, " +
          'preview_html = NULL, redacted_at = NOW() ' +
          'WHERE letter_id IN (SELECT letter_id FROM due)'
      );
    });

    it('redacts strictly OLDER than the LIVE window, never newer', async () => {
      await purgeExpiredLetterContent(90);

      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sqlFrom([sql])).toContain(
        'AND COALESCE(l.sent_at, l.created_at) < NOW() - make_interval(days => $1::int)'
      );
      // 83 live, not 90: the quarantine carries the remaining 7.
      expect(params[0]).toBe(83);
      expect(params[6]).toBe(7);
    });

    it('HOLDS a letter whose mail is still in flight', async () => {
      await purgeExpiredLetterContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND NOT EXISTS ( SELECT 1 FROM letter_jobs j WHERE j.letter_id = l.letter_id ' +
          'AND NOT (j.status = ANY($3::varchar[])) )'
      );
    });

    it('HOLDS a letter whose directly-linked order is unsettled', async () => {
      await purgeExpiredLetterContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND NOT EXISTS ( SELECT 1 FROM orders o WHERE o.letter_id = l.letter_id ' +
          'AND NOT (o.status = ANY($4::varchar[])) )'
      );
    });

    it('LEFT JOINs the ledger, so an unresolvable money lot HOLDS', async () => {
      // An INNER JOIN dropped every lot with a NULL source_order_id - admin
      // comps, compensating lots, pre-023 purchases - and RELEASED the hold,
      // destroying the chargeback evidence the arm exists to preserve.
      await purgeExpiredLetterContent();
      const sql = sqlFrom(mocks.query.mock.calls[0]);

      expect(sql).toContain('LEFT JOIN orders o ON o.order_id = lot.source_order_id');
      expect(sql).toContain('AND txn.reference_id = l.letter_id');
      expect(sql).toContain(
        "( lot.status = 'revoked' " +
          'OR (o.order_id IS NULL AND lot.source_type::text = ANY($5::varchar[])) ' +
          'OR (o.order_id IS NOT NULL AND NOT (o.status = ANY($4::varchar[]))) )'
      );
    });

    it('holds only MONEY-backed lots when the order is unresolvable', async () => {
      await purgeExpiredLetterContent();

      const params = mocks.query.mock.calls[0][1] as unknown[];
      // A promo or signup grant cannot be charged back, so a NULL order there
      // is not a reason to keep the letter forever.
      expect(params[4]).toEqual(['purchase', 'adjustment', 'refund']);
      for (const free of ['promo', 'signup_bonus', 'legacy']) {
        expect(params[4]).not.toContain(free);
      }
    });

    it('passes ALLOW-lists, so an unknown future status holds rather than redacts', async () => {
      await purgeExpiredLetterContent();

      const params = mocks.query.mock.calls[0][1] as unknown[];
      expect(params[1]).toEqual([
        'sent',
        'accepted',
        'in_transit',
        'delivered',
        'returned',
        'failed',
        'cancelled'
      ]);
      for (const pending of ['draft', 'queued', 'processing', 'held']) {
        expect(params[1]).not.toContain(pending);
      }
      // 'failed' is not settled: claimJob dispatches on pending|failed.
      expect(params[2]).toEqual(['completed', 'cancelled']);
      expect(params[3]).toEqual(['fulfilled', 'refunded', 'cancelled', 'payment_failed']);
      for (const contested of ['disputed', 'refund_pending', 'held', 'paid']) {
        expect(params[3]).not.toContain(contested);
      }
    });

    it('skips redacted rows, bounds the batch and never returns identifiers', async () => {
      await purgeExpiredLetterContent(30, 7);

      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sqlFrom([sql])).toContain('WHERE l.redacted_at IS NULL');
      expect(sqlFrom([sql])).toContain('LIMIT $6::int FOR UPDATE OF l SKIP LOCKED');
      expect(params[5]).toBe(7);
      expect(sql).not.toContain('RETURNING');
      expect(sql).not.toContain('DELETE FROM letters');
    });
  });

  // The two draft sweeps are pinned symmetrically. A review proved the earlier
  // suite asserted none of this for either of them.
  describe.each([
    ['purgePaidDraftContent', () => purgePaidDraftContent(), 4, 5],
    ['purgeAbandonedDraftContent', () => purgeAbandonedDraftContent(), 3, 4]
  ])('%s', (_name, run, jobParam, limitParam) => {
    it('saves draft content to quarantine before emptying the row', async () => {
      await run();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain(
        'INSERT INTO redacted_content_quarantine (source_table, source_id, content, purge_after)'
      );
      expect(sql).toContain("SELECT 'letter_drafts', d.draft_id::text,");
      expect(sql).toMatch(/NOW\(\) \+ make_interval\(days => \$\d::int\)/);
      // Every cleared column is saved, including the layout images an earlier
      // version never cleared at all.
      for (const column of [
        'sender',
        'recipient',
        'body_text',
        'sign_off',
        'preview_html',
        'sender_validation',
        'recipient_validation',
        'front_image_data',
        'header_image_data',
        'inline_image_data'
      ]) {
        expect(sql).toContain(`'${column}', to_jsonb(d.${column})`);
      }
    });

    it('bounds the UPDATE to the due CTE', async () => {
      await run();

      // `WHERE TRUE` here empties every draft in the table, and neither draft
      // sweep had this pin before.
      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'WHERE draft_id IN (SELECT draft_id FROM due)'
      );
    });

    it('HOLDS a draft whose consumed letter still has live work', async () => {
      await run();

      // Untested in BOTH lanes previously: no unit assertion mentioned
      // letter_jobs here, and every integration fixture left
      // consumed_letter_id NULL, so the clause was vacuously true throughout.
      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND NOT EXISTS ( SELECT 1 FROM letter_jobs j WHERE d.consumed_letter_id IS NOT NULL ' +
          `AND j.letter_id = d.consumed_letter_id AND NOT (j.status = ANY($${jobParam}::varchar[])) )`
      );
      const params = mocks.query.mock.calls[0][1] as unknown[];
      expect(params[jobParam - 1]).toEqual(['completed', 'cancelled']);
    });

    it('skips redacted rows and bounds the batch', async () => {
      await run();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain('WHERE d.redacted_at IS NULL');
      expect(sql).toContain(`LIMIT $${limitParam}::int FOR UPDATE OF d SKIP LOCKED`);
    });

    it('clears every content column but keeps required_credits', async () => {
      await run();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      for (const image of ['front_image_data', 'header_image_data', 'inline_image_data']) {
        // Emptied, not nulled: the layout CHECK constraints have no liveness
        // condition, so a NULL aborts the batch and rolls back every due row.
        expect(sql).toContain(`${image} = CASE WHEN ${image} IS NULL THEN NULL ELSE '' END`);
      }
      expect(sql).not.toMatch(/required_credits\s*=/);
    });
  });

  describe('purgePaidDraftContent specifics', () => {
    it('requires an order in a PAID state, not merely an order row', async () => {
      await purgePaidDraftContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND EXISTS ( SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id ' +
          'AND o.status = ANY($2::varchar[]) )'
      );
      const params = mocks.query.mock.calls[0][1] as unknown[];
      expect(params[1]).toEqual([
        'paid',
        'fulfillment_pending',
        'fulfilled',
        'refund_pending',
        'refunded',
        'disputed',
        'held'
      ]);
      expect(params[2]).toEqual(['fulfilled', 'refunded', 'cancelled', 'payment_failed']);
    });

    it('clocks from write-once columns, never trigger-managed updated_at', async () => {
      await purgePaidDraftContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain(
        'AND COALESCE(d.consumed_at, d.created_at) < NOW() - make_interval(days => $1::int)'
      );
      expect(sql).not.toContain('d.updated_at');
    });
  });

  describe('purgeAbandonedDraftContent specifics', () => {
    it('proves never-paid with an ALLOW-list, so an unknown status holds', async () => {
      await purgeAbandonedDraftContent();

      // Phrased as the ABSENCE of a paid status this was a deny-list on the
      // shortest clock: an unrecognised status meant "never paid" and the
      // draft was destroyed 83 days early.
      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND NOT EXISTS ( SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id ' +
          'AND NOT (o.status = ANY($2::varchar[])) )'
      );
    });

    it('does NOT treat a pending checkout as never-paid', async () => {
      await purgeAbandonedDraftContent();

      const params = mocks.query.mock.calls[0][1] as unknown[];
      expect(params[1]).toEqual(['cancelled', 'payment_failed']);
      // An ACH/SEPA payment can still land days later; commerce maintenance
      // deliberately leaves such orders pending. Treating pending as abandoned
      // destroyed the only copy of the draft the night before payment.
      expect(params[1]).not.toContain('checkout_pending');
    });

    it('uses the unpaid window and clocks from created_at', async () => {
      await purgeAbandonedDraftContent();

      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sqlFrom([sql])).toContain(
        'AND d.created_at < NOW() - make_interval(days => $1::int)'
      );
      // 7 published = 4 live + 3 quarantine.
      expect(params[0]).toBe(4);
      expect(params[4]).toBe(3);
    });
  });

  describe('purgeExpiredQuarantine', () => {
    it('is the simplest statement in the module: one table, one column', async () => {
      await purgeExpiredQuarantine();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain('DELETE FROM redacted_content_quarantine');
      // Pinned WHOLE, between its ORDER BY and its LIMIT: any extra condition
      // here silently strands a class of quarantine rows forever.
      expect(sql).toContain('WHERE purge_after <= NOW() ORDER BY purge_after LIMIT $1::int');
      // This is the statement that finally destroys content. Nothing a future
      // migration can invalidate may appear in it.
      expect(sql).not.toContain('JOIN');
      expect(sql).not.toContain('status');
      expect(sql).not.toContain('orders');
      expect(sql).not.toContain('letter_jobs');
    });

    it('bounds its own batch', async () => {
      await purgeExpiredQuarantine(50);

      expect(mocks.query.mock.calls[0][1]).toEqual([50]);
    });
  });

  describe('restoreQuarantinedContent', () => {
    it('puts a letter back and re-opens it to a future sweep', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });

      expect(await restoreQuarantinedContent('letters', 'letter-1')).toBe(true);

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain("content = (SELECT content->'content' FROM saved)");
      expect(sql).toContain("recipient = (SELECT content->'recipient' FROM saved)");
      // Clearing redacted_at is what makes the row eligible again, so a fixed
      // predicate can re-sweep it instead of needing a hand-written backfill.
      expect(sql).toContain('redacted_at = NULL');
    });

    it('restores every draft content column it cleared', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });

      await restoreQuarantinedContent('letter_drafts', 'draft-1');

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      for (const jsonColumn of ['sender', 'recipient']) {
        expect(sql).toContain(`${jsonColumn} = (SELECT content->'${jsonColumn}' FROM saved)`);
      }
      for (const textColumn of ['body_text', 'header_image_data', 'inline_image_url']) {
        expect(sql).toContain(`${textColumn} = (SELECT content->>'${textColumn}' FROM saved)`);
      }
    });

    it('reports false when the recovery window has already expired', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });

      expect(await restoreQuarantinedContent('letters', 'gone')).toBe(false);
      // No delete is attempted when nothing was restored.
      expect(mocks.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('parameter validation', () => {
    it.each([0, 1, -1, 1.5, Number.NaN])('refuses retentionDays %s', async bad => {
      await expect(purgeExpiredLetterContent(bad as number)).rejects.toThrow(/at least 2/);
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it.each([0, -1, 5001])('refuses batchLimit %s', async bad => {
      await expect(purgeExpiredLetterContent(90, bad as number)).rejects.toThrow(/batchLimit/);
      expect(mocks.query).not.toHaveBeenCalled();
    });
  });

  describe('runRetentionSweep', () => {
    it('reports counts and error CLASSES, never ids or driver messages', async () => {
      mocks.query.mockResolvedValue({ rows: [{ letter_id: 'letter_1' }], rowCount: 1 });

      const summary = await runRetentionSweep();

      expect(summary).toEqual({
        lettersRedacted: 1,
        draftsRedacted: 1,
        abandonedDraftsRedacted: 1,
        quarantinePurged: 1,
        moreWaiting: false,
        errors: []
      });
      expect(JSON.stringify(summary)).not.toContain('letter_1');
    });

    it('carries a class, not the Postgres message, when a sweep fails', async () => {
      // A driver message routinely embeds the offending value; this result is
      // logged, and #153 forbids deleted content reappearing in logs.
      mocks.query
        .mockRejectedValueOnce(
          new Error('invalid input syntax for type uuid: "dear-sam-221b-baker-street"')
        )
        .mockResolvedValue({ rows: [], rowCount: 3 });

      const summary = await runRetentionSweep();

      expect(summary.lettersRedacted).toBe(0);
      expect(summary.draftsRedacted).toBe(3);
      expect(JSON.stringify(summary)).not.toContain('baker-street');
      expect(summary.errors[0]).toMatch(/^letters:/);
    });

    it('runs the remaining sweeps when one fails', async () => {
      mocks.query.mockRejectedValueOnce(new Error('lock timeout')).mockResolvedValue({
        rows: [],
        rowCount: 2
      });

      const summary = await runRetentionSweep();

      expect(summary.draftsRedacted).toBe(2);
      expect(summary.abandonedDraftsRedacted).toBe(2);
      expect(summary.quarantinePurged).toBe(2);
    });

    it('flags more work when a batch fills OR a sweep failed', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 5 });
      expect(await runRetentionSweep(90, 5)).toMatchObject({ moreWaiting: true });

      mocks.query.mockReset();
      mocks.query.mockRejectedValue(new Error('down'));
      // A failed sweep left the count at 0, which previously read as
      // "caught up" at the exact moment the backlog was largest.
      expect(await runRetentionSweep()).toMatchObject({ moreWaiting: true });
    });

    it('uses the unpaid window for abandoned drafts regardless of the caller', async () => {
      await runRetentionSweep(365, 9);

      const windows = mocks.query.mock.calls.map(call => (call[1] as unknown[])[0]);
      // 365 -> 358 live for letters and paid drafts; 7 -> 4 for abandoned;
      // the quarantine purge takes only a batch limit.
      expect(windows).toEqual([358, 358, 4, 9]);
    });
  });
});

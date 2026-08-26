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
  runRetentionSweep
} = await import('../../../src/services/retentionService.js');

/**
 * Issue #153 - guards on an IRREVERSIBLE sweep.
 *
 * WHY THESE ASSERT WHOLE CLAUSES RATHER THAN FRAGMENTS
 * The first version of this suite matched loose substrings - `FROM orders`,
 * the status list, `LIMIT $n` - and was proven worthless by mutation: with the
 * outer `WHERE letter_id IN (...)` replaced by `WHERE TRUE` (redacting EVERY
 * letter in the table), with `NOT EXISTS` inverted to `EXISTS` (redacting
 * exactly the rows that must be held), and with the boundary `<` flipped to
 * `>` (redacting the last 90 days instead of everything older), it still
 * passed 16/16. None of those mutations removes the fragments it matched.
 *
 * Each guard is therefore pinned as a complete normalized clause INCLUDING its
 * polarity token, and the outer UPDATE is pinned in full. Behaviour is proven
 * against real PostgreSQL in tests/integration/contentRetention.postgres.test.ts;
 * this suite exists so the Docker-free lane still reddens on a polarity flip.
 */
function sqlFrom(call: unknown[]): string {
  return String(call[0]).replace(/\s+/g, ' ').trim();
}

describe('retention sweep guards (#153)', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('purgeExpiredLetterContent', () => {
    it('bounds the UPDATE to the due CTE and to the content columns', async () => {
      await purgeExpiredLetterContent();

      // Pinned WHOLE. `WHERE TRUE` here redacts every letter ever sent.
      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        "UPDATE letters SET content = '{}'::jsonb, recipient = '{}'::jsonb, " +
          'preview_html = NULL, redacted_at = NOW() ' +
          'WHERE letter_id IN (SELECT letter_id FROM due)'
      );
    });

    it('redacts strictly OLDER than the window, never newer', async () => {
      await purgeExpiredLetterContent();

      // Pinned with the operator. `>` inverts the sweep in time.
      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND COALESCE(l.sent_at, l.created_at) < NOW() - make_interval(days => $1::int)'
      );
    });

    it('HOLDS a letter whose mail is still in flight', async () => {
      await purgeExpiredLetterContent();

      // NOT EXISTS ... AND NOT (settled) - inverting either token turns a hold
      // into a targeting filter.
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

    it('HOLDS a PREPAID letter through the credit ledger, not just orders.letter_id', async () => {
      // orders.letter_id is written only for jit_mail, so a hold keyed on it
      // alone is vacuously true for every prepaid letter - the majority path.
      // Without this arm, a pack chargeback destroys every letter it funded.
      await purgeExpiredLetterContent();
      const sql = sqlFrom(mocks.query.mock.calls[0]);

      expect(sql).toContain(
        'FROM credit_transactions txn ' +
          'JOIN credit_consumption cc ON cc.transaction_id = txn.transaction_id ' +
          'JOIN credit_ledger lot ON lot.ledger_id = cc.ledger_id ' +
          'JOIN orders o ON o.order_id = lot.source_order_id'
      );
      expect(sql).toContain("WHERE txn.reference_type = 'letter' AND txn.type = 'deduction'");
    });

    it('only redacts letters in a finished state', async () => {
      await purgeExpiredLetterContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain('AND l.status = ANY($2::varchar[])');
    });

    it('passes ALLOW-lists, so an unknown future status holds rather than redacts', async () => {
      await purgeExpiredLetterContent();

      const params = mocks.query.mock.calls[0][1] as unknown[];
      // Letter states safe to redact: work-pending states are absent.
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
      // 'failed' is deliberately NOT a settled job: claimJob dispatches on
      // status IN ('pending','failed') and the operator retry re-enqueues it.
      expect(params[2]).toEqual(['completed', 'cancelled']);
      expect(params[2]).not.toContain('failed');
      // 'paid'/'fulfillment_pending' hold: charged, content still the only copy.
      expect(params[3]).toEqual(['fulfilled', 'refunded', 'cancelled', 'payment_failed']);
      for (const contested of ['disputed', 'refund_pending', 'held', 'paid']) {
        expect(params[3]).not.toContain(contested);
      }
    });

    it('skips rows already redacted and bounds the batch', async () => {
      await purgeExpiredLetterContent(30, 7);

      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sqlFrom([sql])).toContain('WHERE l.redacted_at IS NULL');
      expect(sqlFrom([sql])).toContain('LIMIT $5::int FOR UPDATE OF l SKIP LOCKED');
      expect(params[0]).toBe(30);
      expect(params[4]).toBe(7);
      // The window must never be a literal.
      expect(sql).not.toMatch(/INTERVAL '90 days'/);
    });

    it('never deletes a row and never returns identifiers', async () => {
      await purgeExpiredLetterContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).not.toContain('DELETE FROM letters');
      // No RETURNING: the ids cannot reach this process to be logged at all.
      expect(sql).not.toContain('RETURNING');
    });
  });

  describe('purgePaidDraftContent', () => {
    it('requires an order in a PAID state, not merely an order row', async () => {
      await purgePaidDraftContent();

      // An abandoned checkout leaves a 'checkout_pending' order behind;
      // treating that as paid gave a never-paid draft 90-day retention.
      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND EXISTS ( SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id ' +
          'AND o.status = ANY($2::varchar[]) )'
      );
      const params = mocks.query.mock.calls[0][1] as unknown[];
      for (const unpaid of ['checkout_pending', 'cancelled', 'payment_failed']) {
        expect(params[1]).not.toContain(unpaid);
      }
    });

    it('HOLDS a draft whose order is unsettled', async () => {
      await purgePaidDraftContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND NOT EXISTS ( SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id ' +
          'AND NOT (o.status = ANY($3::varchar[])) )'
      );
    });

    it('clocks from write-once columns, never from trigger-managed updated_at', async () => {
      await purgePaidDraftContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain(
        'AND COALESCE(d.consumed_at, d.created_at) < NOW() - make_interval(days => $1::int)'
      );
      // letter_drafts has a BEFORE UPDATE trigger that rewrites updated_at, so
      // using it as the clock lets any future writer restart the window.
      expect(sql).not.toContain('d.updated_at');
    });

    it('clears EVERY content column, including the layout images', async () => {
      await purgePaidDraftContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      for (const column of [
        "sender = '{}'::jsonb",
        "recipient = '{}'::jsonb",
        "body_text = ''",
        'preview_html = NULL',
        'sender_validation = NULL',
        'recipient_validation = NULL',
        'front_image_url = NULL',
        'header_image_url = NULL',
        'inline_image_url = NULL',
        'redacted_at = NOW()'
      ]) {
        expect(sql).toContain(column);
      }
      // The three image blobs are EMPTIED, not nulled: postcard_requires_image,
      // header_layout_requires_image and inline_layout_requires_image have no
      // liveness condition, so a NULL aborts the batch and rolls back every
      // other due row with it.
      for (const image of ['front_image_data', 'header_image_data', 'inline_image_data']) {
        expect(sql).toContain(`${image} = CASE WHEN ${image} IS NULL THEN NULL ELSE '' END`);
      }
      expect(sql).not.toMatch(/required_credits\s*=/);
    });
  });

  describe('purgeAbandonedDraftContent', () => {
    it('targets drafts with an order but NO paid order, on the 7-day window', async () => {
      await purgeAbandonedDraftContent();

      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      const normalized = sqlFrom([sql]);
      expect(normalized).toContain(
        'AND EXISTS ( SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id )'
      );
      expect(normalized).toContain(
        'AND NOT EXISTS ( SELECT 1 FROM orders o WHERE o.draft_id = d.draft_id ' +
          'AND o.status = ANY($2::varchar[]) )'
      );
      // The unpaid window, not the letter-content window.
      expect(params[0]).toBe(7);
    });

    it('clocks from created_at, since an abandoned draft was never consumed', async () => {
      await purgeAbandonedDraftContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'AND d.created_at < NOW() - make_interval(days => $1::int)'
      );
    });
  });

  describe('parameter validation', () => {
    it.each([0, -1, 1.5, Number.NaN])('refuses retentionDays %s', async bad => {
      await expect(purgeExpiredLetterContent(bad as number)).rejects.toThrow(/positive integer/);
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it.each([0, -1, 5001])('refuses batchLimit %s', async bad => {
      await expect(purgeExpiredLetterContent(90, bad as number)).rejects.toThrow(/batchLimit/);
      expect(mocks.query).not.toHaveBeenCalled();
    });
  });

  describe('runRetentionSweep', () => {
    it('reports counts only, never an id or any content', async () => {
      mocks.query.mockResolvedValue({ rows: [{ letter_id: 'letter_1' }], rowCount: 1 });

      const summary = await runRetentionSweep();

      expect(summary).toEqual({
        lettersRedacted: 1,
        draftsRedacted: 1,
        abandonedDraftsRedacted: 1,
        moreWaiting: false,
        errors: []
      });
      expect(JSON.stringify(summary)).not.toContain('letter_1');
    });

    it('runs the other sweeps when one fails, and names which failed', async () => {
      mocks.query
        .mockRejectedValueOnce(new Error('lock timeout'))
        .mockResolvedValue({ rows: [], rowCount: 3 });

      const summary = await runRetentionSweep();

      expect(summary.lettersRedacted).toBe(0);
      expect(summary.draftsRedacted).toBe(3);
      expect(summary.abandonedDraftsRedacted).toBe(3);
      expect(summary.errors).toEqual(['letters: lock timeout']);
    });

    it('flags a remaining backlog when any batch fills', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 5 });

      expect(await runRetentionSweep(90, 5)).toMatchObject({ moreWaiting: true });
    });

    it('uses the unpaid window for abandoned drafts regardless of the caller', async () => {
      await runRetentionSweep(365, 9);

      const windows = mocks.query.mock.calls.map(call => (call[1] as unknown[])[0]);
      expect(windows).toEqual([365, 365, 7]);
    });
  });
});

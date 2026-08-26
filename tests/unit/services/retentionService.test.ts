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
  runRetentionSweep
} = await import('../../../src/services/retentionService.js');

/**
 * Issue #153 - the retention sweep enforces a PUBLISHED promise, so the guards
 * that keep it from over-deleting are as load-bearing as the delete itself.
 *
 * These are statement-shape assertions, deliberately. The behavioural proof
 * lives in tests/integration/contentRetention.postgres.test.ts against real
 * PostgreSQL, because a mocked query() will accept a predicate that matches
 * every row in the table. What this suite buys is that the whole unit lane -
 * which runs without Docker - reddens if any guard is deleted, rather than
 * that failure waiting for the integration job.
 */
function sqlFrom(call: unknown[]): string {
  return String(call[0]).replace(/\s+/g, ' ');
}

describe('retention sweep guards (#153)', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('purgeExpiredLetterContent', () => {
    it('holds letters whose mail is still in flight, including HELD jobs', async () => {
      await purgeExpiredLetterContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain('FROM letter_jobs');
      // 'held' is where migration 023 parks an AMBIGUOUS provider outcome for
      // operator reconciliation - the case that most needs the content kept.
      expect(sql).toMatch(/j\.status IN \('pending', 'processing', 'held'\)/);
    });

    it('holds letters whose order is disputed or awaiting refund', async () => {
      await purgeExpiredLetterContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain('FROM orders');
      expect(sql).toMatch(/o\.status IN \('disputed', 'refund_pending', 'held'\)/);
    });

    it('scopes the dispute hold to the letter, never to the user or the sweep', async () => {
      // #153: holds must be "explicit, scoped, auditable, and do not silently
      // disable all cleanup". A hold keyed on user_id would stop retention for
      // every letter that customer ever sent.
      await purgeExpiredLetterContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain('o.letter_id = l.letter_id');
      expect(sql).not.toMatch(/o\.user_id\s*=/);
    });

    it('only ever touches sent letters', async () => {
      await purgeExpiredLetterContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain('l.sent_at IS NOT NULL');
    });

    it('skips rows already redacted, so a repeat run is a no-op', async () => {
      await purgeExpiredLetterContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain('l.content <> $2::jsonb');
    });

    it('binds the window, the sentinel and the batch limit in that order', async () => {
      // The recurring defect class in this repo is a parameter bound to the
      // wrong ordinal, which mocked tests miss because nothing type-checks $n
      // against the value. Pin the order explicitly.
      await purgeExpiredLetterContent(30, 7);

      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([30, '{"redacted":true}', 7]);
      expect(sql).toContain('make_interval(days => $1::int)');
      expect(sql).toContain('LIMIT $3::int');
      // The window must never be a literal - a hardcoded 90 would ignore the
      // approved schedule the moment it changes.
      expect(sql).not.toMatch(/INTERVAL '90 days'/);
    });

    it('bounds the work and does not block on rows another sweep holds', async () => {
      await purgeExpiredLetterContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain('LIMIT $3::int');
      expect(sql).toContain('SKIP LOCKED');
    });

    it('overwrites every content column and nothing else', async () => {
      await purgeExpiredLetterContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toContain('SET content = $2::jsonb');
      expect(sql).toContain('recipient = $2::jsonb');
      expect(sql).toContain('preview_html = NULL');
      // Anonymize, never delete: the order and ledger rows reference this row
      // and the #158 gate requires the financial trail to survive.
      expect(sql).not.toContain('DELETE FROM letters');
      expect(sql).not.toContain('sent_at = NULL');
      expect(sql).not.toMatch(/SET .*status\s*=/);
    });
  });

  describe('purgePaidDraftContent', () => {
    it('only touches drafts that actually have an order', async () => {
      await purgePaidDraftContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      // Unpaid drafts belong to cleanupOldDrafts' 7-day DELETE. Redacting one
      // here would leave an undeletable husk instead of removing the row.
      expect(sql).toMatch(/EXISTS \( SELECT 1 FROM orders o WHERE o\.draft_id = d\.draft_id \)/);
    });

    it('carries the same two holds as the letter sweep', async () => {
      await purgePaidDraftContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      expect(sql).toMatch(/o\.status IN \('disputed', 'refund_pending', 'held'\)/);
      expect(sql).toMatch(/j\.status IN \('pending', 'processing', 'held'\)/);
    });

    it('dates a consumed draft from consumption and an unconsumed one from its last change', async () => {
      await purgePaidDraftContent();

      expect(sqlFrom(mocks.query.mock.calls[0])).toContain(
        'COALESCE(d.consumed_at, d.updated_at) <'
      );
    });

    it('clears every content column but keeps required_credits', async () => {
      await purgePaidDraftContent();

      const sql = sqlFrom(mocks.query.mock.calls[0]);
      for (const column of [
        'sender = $2::jsonb',
        'recipient = $2::jsonb',
        "body_text = ''",
        "sign_off = ''",
        'preview_html = NULL',
        'sender_validation = NULL',
        'recipient_validation = NULL'
      ]) {
        expect(sql).toContain(column);
      }
      // CHECK (required_credits > 0), and the refund path still reads it.
      expect(sql).not.toMatch(/required_credits\s*=/);
    });
  });

  describe('runRetentionSweep', () => {
    it('reports counts only - never an id, an address, or any content', async () => {
      mocks.query.mockResolvedValue({ rows: [{ letter_id: 'letter_1' }], rowCount: 1 });

      const summary = await runRetentionSweep();

      expect(summary).toEqual({ lettersRedacted: 1, draftsRedacted: 1, moreWaiting: false });
      // #153 forbids compensating for deleted content by logging it. The
      // RETURNING ids must not escape into the summary the caller prints.
      expect(JSON.stringify(summary)).not.toContain('letter_1');
    });

    it('flags more work waiting when a batch fills', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 5 });

      expect(await runRetentionSweep(90, 5)).toMatchObject({ moreWaiting: true });
    });

    it('does not flag more work when neither batch filled', async () => {
      mocks.query.mockResolvedValue({ rows: [], rowCount: 4 });

      expect(await runRetentionSweep(90, 5)).toMatchObject({ moreWaiting: false });
    });

    it('passes the caller window and limit down to BOTH sweeps', async () => {
      await runRetentionSweep(30, 9);

      expect(mocks.query.mock.calls).toHaveLength(2);
      for (const call of mocks.query.mock.calls) {
        expect(call[1]).toEqual([30, '{"redacted":true}', 9]);
      }
    });
  });
});

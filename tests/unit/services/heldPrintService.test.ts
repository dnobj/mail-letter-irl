/**
 * Held mail prints as previewed (#697, decision D3): what the send records,
 * the PDF it stores after the commit, what the print reads back, and the
 * maintenance run's backfill and sweep. The database is mocked; the bucket
 * runs in memory. heldPrintPdf.postgres.test.ts runs the same against
 * PostgreSQL's constraints.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const diagnostics = vi.hoisted(() => ({ written: [] as Array<{ level: string; event: string; fields: Record<string, unknown> }> }));
vi.mock('../../../src/utils/diagnosticLog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: (level: string, event: string, fields: Record<string, unknown> = {}) => {
    diagnostics.written.push({ level, event, fields });
  }
}));
vi.mock('../../../src/db/index.js', () => ({ transaction: vi.fn(), query: vi.fn() }));

import { query } from '../../../src/db/index.js';
import { LAYOUT_ENGINE_VERSION, layoutFingerprint, RENDERER_VERSION } from '../../../src/render/index.js';
import {
  backfillHeldPrints,
  HELD_PDF_GRACE_MS,
  printLayoutOf,
  recordHeldPrintWithClient,
  storeHeldPrint,
  sweepHeldPdfs
} from '../../../src/services/heldPrintService.js';
import { forgetHeldPdf, storedHeldPdf } from '../../../src/services/heldPrintPdf.js';
import { drawPrintPdf } from '../../../src/services/printDocument.js';
import { deleteHeldPdf, getHeldPdf, listHeldPdfs, storeHeldPdf } from '../../../src/services/tempImageStore.js';
import type { Letter } from '../../../src/services/types.js';

const LETTER_ID = '0b7c6a52-1d2e-4f3a-9b8c-7d6e5f4a3b2c';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function heldLetter(extra: Partial<Letter> = {}): Letter {
  return {
    letter_id: LETTER_ID,
    user_id: 'auth0|held',
    content: {
      bodyText: 'Dear Sam,\n\nHappy birthday.',
      signOff: 'Warmly,\nTest',
      layoutType: 'text_only',
      rendererVersion: RENDERER_VERSION,
      sender: { name: 'Test Sender', addressLine1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' }
    },
    recipient: { name: 'Sam Rivera', addressLine1: '350 5th Ave', city: 'New York', state: 'NY', postalCode: '10118' },
    credits_cost: 1,
    status: 'queued',
    mail_type: 'letter',
    funding_type: 'prepaid_balance',
    mail_on: '2026-11-02',
    created_at: new Date('2026-10-17T12:00:00Z'),
    redacted_at: null,
    print_pdf_sha256: null,
    print_layout_fingerprint: null,
    print_layout_engine: null,
    ...extra
  } as Letter;
}

function fingerprintOf(letter: Letter): string {
  const print = printLayoutOf(letter);
  return layoutFingerprint(print.layout, print.rendererVersion);
}

const NOW = new Date('2026-10-17T12:00:00Z');
const LATER = new Date('2026-11-02T16:00:00Z');

beforeAll(() => {
  vi.stubEnv('TEMP_IMAGE_STORE', 'memory');
});

beforeEach(async () => {
  diagnostics.written.length = 0;
  vi.mocked(query).mockReset();
  for (const { letterId } of await listHeldPdfs()) await deleteHeldPdf(letterId);
});

afterEach(() => {
  vi.mocked(query).mockReset();
});

describe('printLayoutOf (#697)', () => {
  it('lays a letter out as the print does, and refuses what the print would', () => {
    expect(printLayoutOf(heldLetter()).rendererVersion).toBe(RENDERER_VERSION);
    expect(() => printLayoutOf(heldLetter({ content: { ...heldLetter().content, rendererVersion: 'pdf-99' } }))).toThrow();
    expect(() => printLayoutOf(heldLetter({ content: { ...heldLetter().content, rendererVersion: undefined } }))).toThrow();
  });

  it('lays a postcard out at its size, and refuses a size no writer stores', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';
    const postcard = heldLetter({
      mail_type: 'postcard',
      content: { message: 'Hi Sam', frontImageData: PNG, postcardSize: '6x4', rendererVersion: RENDERER_VERSION }
    });
    expect(printLayoutOf(postcard).layout.width).toBeGreaterThan(0);
    expect(() => printLayoutOf(heldLetter({ ...postcard, content: { ...postcard.content, postcardSize: '5x7' } }))).toThrow();
  });
});

describe('recordHeldPrintWithClient (#697)', () => {
  const client = () => ({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) });

  it('records the fingerprint and the engine for held mail our renderer draws, under a savepoint', async () => {
    const db = client();
    const letter = heldLetter();
    await recordHeldPrintWithClient(db, letter, LATER, NOW);
    const calls = db.query.mock.calls.map(call => String(call[0]));
    expect(calls[0]).toBe('SAVEPOINT held_print');
    expect(calls[1]).toContain('UPDATE letters SET print_layout_fingerprint = $2, print_layout_engine = $3 WHERE letter_id = $1');
    expect(db.query.mock.calls[1][1]).toEqual([LETTER_ID, fingerprintOf(letter), LAYOUT_ENGINE_VERSION]);
    expect(calls[2]).toBe('RELEASE SAVEPOINT held_print');
  });

  it('records nothing for mail not held, or released by now, or drawn by the legacy HTML', async () => {
    for (const [letter, releaseAt] of [
      [heldLetter(), undefined],
      [heldLetter(), NOW],
      [heldLetter(), new Date(NOW.getTime() - 1)],
      [heldLetter({ content: { ...heldLetter().content, rendererVersion: undefined } }), LATER]
    ] as const) {
      const db = client();
      await recordHeldPrintWithClient(db, letter, releaseAt, NOW);
      expect(db.query).not.toHaveBeenCalled();
    }
    // Quietly: mail the legacy HTML draws is not a failure to record.
    expect(diagnostics.written).toEqual([]);
  });

  it('records nothing, and says so, for mail it cannot lay out', async () => {
    const db = client();
    await recordHeldPrintWithClient(db, heldLetter({ content: { ...heldLetter().content, pages: 4 } }), LATER, NOW);
    expect(db.query).not.toHaveBeenCalled();
    expect(diagnostics.written).toContainEqual(expect.objectContaining({ event: 'held_print.not_recorded', fields: expect.objectContaining({ errorClass: 'pages' }) }));
  });

  it('rolls back to its savepoint and lets the send go on when the write fails', async () => {
    const db = client();
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('column "print_layout_fingerprint" does not exist'), { code: '42703' }));
    await expect(recordHeldPrintWithClient(db, heldLetter(), LATER, NOW)).resolves.toBeUndefined();
    expect(db.query.mock.calls.map(call => String(call[0]))).toEqual([
      'SAVEPOINT held_print',
      expect.stringContaining('UPDATE letters'),
      'ROLLBACK TO SAVEPOINT held_print'
    ]);
    expect(diagnostics.written).toContainEqual(expect.objectContaining({ level: 'error', event: 'held_print.not_recorded' }));
  });
});

describe('storeHeldPrint (#697)', () => {
  function rows(letter: Letter | undefined, updated = 1) {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM letters')) return { rows: letter ? [letter] : [], rowCount: letter ? 1 : 0 } as never;
      if (sql.includes('UPDATE letters SET print_pdf_sha256')) return { rows: [], rowCount: updated } as never;
      throw new Error(`unexpected query: ${sql}`);
    });
  }

  it("stores the PDF of the letter's recorded layout, then records its SHA-256", async () => {
    const letter = heldLetter();
    letter.print_layout_fingerprint = fingerprintOf(letter);
    rows(letter);
    await expect(storeHeldPrint(LETTER_ID)).resolves.toBe('stored');
    const stored = await getHeldPdf(LETTER_ID);
    expect(stored?.equals(await drawPrintPdf(printLayoutOf(letter), 'letter'))).toBe(true);
    const update = vi.mocked(query).mock.calls.find(call => String(call[0]).includes('UPDATE letters SET print_pdf_sha256'))!;
    expect(update[1]).toEqual([LETTER_ID, sha256(stored!), letter.print_layout_fingerprint]);
    // Only for a letter that still waits, as it was read, and still has none.
    for (const clause of ["status = 'queued'", '(print_pdf_sha256 IS NULL OR print_pdf_sha256 = $2)', 'print_layout_fingerprint = $3', 'mail_on IS NOT NULL', 'redacted_at IS NULL']) {
      expect(String(update[0])).toContain(clause);
    }
  });

  it('deletes the PDF again when the letter stopped waiting meanwhile', async () => {
    const letter = heldLetter();
    letter.print_layout_fingerprint = fingerprintOf(letter);
    rows(letter, 0);
    await expect(storeHeldPrint(LETTER_ID)).resolves.toBe('skipped');
    expect(await getHeldPdf(LETTER_ID)).toBeNull();
  });

  it('stores nothing for a letter that does not wait with a fingerprint and no PDF', async () => {
    const fingerprinted = (extra: Partial<Letter>) => {
      const letter = heldLetter(extra);
      letter.print_layout_fingerprint ??= fingerprintOf(heldLetter());
      return letter;
    };
    for (const letter of [
      undefined,
      heldLetter(),
      fingerprinted({ status: 'processing' }),
      fingerprinted({ status: 'cancelled' }),
      fingerprinted({ mail_on: null }),
      fingerprinted({ redacted_at: new Date() }),
      fingerprinted({ print_pdf_sha256: 'a'.repeat(64) })
    ]) {
      rows(letter);
      await expect(storeHeldPrint(LETTER_ID)).resolves.toBe('skipped');
      expect(vi.mocked(query).mock.calls.some(call => String(call[0]).includes('UPDATE'))).toBe(false);
      vi.mocked(query).mockReset();
    }
    expect(await listHeldPdfs()).toEqual([]);
  });

  it('stores nothing, and says so, for a letter that now lays out otherwise', async () => {
    const letter = heldLetter();
    letter.print_layout_fingerprint = fingerprintOf(heldLetter({ content: { ...heldLetter().content, bodyText: 'Dear Pat,' } }));
    rows(letter);
    await expect(storeHeldPrint(LETTER_ID)).resolves.toBe('layout_changed');
    expect(await listHeldPdfs()).toEqual([]);
    expect(diagnostics.written).toContainEqual(expect.objectContaining({ level: 'error', event: 'held_print.layout_changed', fields: { letterId: LETTER_ID } }));
  });

  it('never throws: a database or bucket failure is a failed store', async () => {
    vi.mocked(query).mockRejectedValue(new Error('connection terminated'));
    await expect(storeHeldPrint(LETTER_ID)).resolves.toBe('failed');
    expect(diagnostics.written).toContainEqual(expect.objectContaining({ level: 'error', event: 'held_print.store_failed' }));
  });
});

describe('storedHeldPdf (#697)', () => {
  it('reads the PDF back when its bytes hash to the recorded SHA-256', async () => {
    const pdf = Buffer.from('%PDF- held');
    await storeHeldPdf(LETTER_ID, pdf);
    expect((await storedHeldPdf({ letter_id: LETTER_ID, print_pdf_sha256: sha256(pdf) }))?.equals(pdf)).toBe(true);
  });

  it('gives none for a letter recording none, for bytes that differ, and for one that is gone', async () => {
    await storeHeldPdf(LETTER_ID, Buffer.from('%PDF- held'));
    expect(await storedHeldPdf({ letter_id: LETTER_ID, print_pdf_sha256: null })).toBeUndefined();
    expect(await storedHeldPdf({ letter_id: LETTER_ID, print_pdf_sha256: 'b'.repeat(64) })).toBeUndefined();
    expect(diagnostics.written).toContainEqual(expect.objectContaining({ event: 'held_print.pdf_mismatch' }));
    await deleteHeldPdf(LETTER_ID);
    expect(await storedHeldPdf({ letter_id: LETTER_ID, print_pdf_sha256: 'b'.repeat(64) })).toBeUndefined();
    expect(diagnostics.written).toContainEqual(expect.objectContaining({ event: 'held_print.pdf_missing' }));
  });

  it('gives none, never a failure, when the store cannot be read', async () => {
    vi.stubEnv('TEMP_IMAGE_STORE', 'bucket');
    try {
      expect(await storedHeldPdf({ letter_id: LETTER_ID, print_pdf_sha256: 'b'.repeat(64) })).toBeUndefined();
      await expect(forgetHeldPdf(LETTER_ID)).resolves.toBeUndefined();
    } finally {
      vi.stubEnv('TEMP_IMAGE_STORE', 'memory');
    }
    expect(diagnostics.written).toContainEqual(expect.objectContaining({ event: 'held_print.pdf_unreadable' }));
    expect(diagnostics.written).toContainEqual(expect.objectContaining({ event: 'held_print.delete_failed' }));
  });
});

describe('sweepHeldPdfs (#697)', () => {
  it('keeps a PDF while its letter waits to print with it, and deletes the rest once past the grace', async () => {
    const waiting = '11111111-1111-4111-8111-111111111111';
    const done = '22222222-2222-4222-8222-222222222222';
    await storeHeldPdf(waiting, Buffer.from('%PDF- a'));
    await storeHeldPdf(done, Buffer.from('%PDF- b'));
    vi.mocked(query).mockResolvedValue({ rows: [{ letter_id: waiting }], rowCount: 1 } as never);

    // Within the grace, nothing is read or deleted: a PDF may be waiting for its row.
    expect(await sweepHeldPdfs(new Date())).toEqual({ kept: 2, deleted: 0 });
    expect(query).not.toHaveBeenCalled();

    const later = new Date(Date.now() + HELD_PDF_GRACE_MS + 1000);
    expect(await sweepHeldPdfs(later)).toEqual({ kept: 1, deleted: 1 });
    expect((await listHeldPdfs()).map(entry => entry.letterId)).toEqual([waiting]);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(String(sql)).toContain("status IN ('queued', 'processing', 'held')");
    expect(String(sql)).toContain('print_pdf_sha256 IS NOT NULL');
    expect(String(sql)).toContain('redacted_at IS NULL');
    expect((params as unknown[])[0]).toEqual(expect.arrayContaining([waiting, done]));
  });
});

describe('backfillHeldPrints (#697)', () => {
  it('stops at the first failed store, for the next run to try again', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM letters l')) return { rows: [{ letter_id: LETTER_ID }, { letter_id: '44444444-4444-4444-8444-444444444444' }], rowCount: 2 } as never;
      throw new Error('connection terminated');
    });
    expect(await backfillHeldPrints()).toEqual({ stored: 0, layoutChanged: 0, failed: 1 });
    // The list, then one letter's read: the second letter is left for the next run.
    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
  });

  it('stores a PDF for each held letter the send left without one, and counts what it found', async () => {
    const letter = heldLetter();
    letter.print_layout_fingerprint = fingerprintOf(letter);
    const changed = heldLetter({ letter_id: '33333333-3333-4333-8333-333333333333' });
    changed.print_layout_fingerprint = fingerprintOf(heldLetter({ content: { ...heldLetter().content, bodyText: 'Dear Pat,' } }));
    vi.mocked(query).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM letters l')) return { rows: [{ letter_id: LETTER_ID }, { letter_id: changed.letter_id }], rowCount: 2 } as never;
      if (sql.startsWith('SELECT * FROM letters')) return { rows: [params?.[0] === LETTER_ID ? letter : changed], rowCount: 1 } as never;
      return { rows: [], rowCount: 1 } as never;
    });
    expect(await backfillHeldPrints()).toEqual({ stored: 1, layoutChanged: 1, failed: 0 });
    expect((await listHeldPdfs()).map(entry => entry.letterId)).toEqual([LETTER_ID]);
    const [sql, params] = vi.mocked(query).mock.calls[0];
    // Left to the send's own store for the grace, and never one about to print.
    expect(String(sql)).toContain('l.created_at < NOW() - make_interval(secs => $1)');
    expect(String(sql)).toContain('j.next_attempt_at > NOW() + make_interval(secs => $1)');
    expect(String(sql)).toContain('l.print_pdf_sha256 IS NULL');
    expect(params).toEqual([HELD_PDF_GRACE_MS / 1000, 50]);
  });
});

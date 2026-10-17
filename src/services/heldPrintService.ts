/**
 * Held mail prints as previewed (#697, decision D3).
 *
 * Mail sent to arrive by a date waits in the outbox until its mail date, up to
 * the schedule's horizon, and a renderer, font or layout rule deployed in
 * between could move its line breaks. So for mail our renderer draws:
 *
 * - the send records, in its transaction, the fingerprint of what the print
 *   will lay out and the layout engine that laid it out
 *   (recordHeldPrintWithClient);
 * - after the commit, the send draws the PDF and stores it in the private
 *   bucket, and records its SHA-256 once the upload has succeeded
 *   (storeHeldPrint). The hourly maintenance run stores any the send could not
 *   (backfillHeldPrints);
 * - the print uploads that PDF when its bytes hash to the recorded SHA-256,
 *   and otherwise lays the mail out again and holds it for an operator when
 *   the fingerprint differs (printDocument.printPdfFor);
 * - the PDF is deleted once the provider accepts the mail, on a cancel, and by
 *   the hourly sweep, which keeps a PDF only while its letter still waits to
 *   print (sweepHeldPdfs) and so covers erasure, retention and an operator's
 *   cancel too.
 *
 * Nothing here refuses or refunds a send: a bucket that is down, or a layout
 * that cannot be fingerprinted, leaves the mail to print as it would have
 * before, with the guards it has. Every function here but the in-transaction
 * record catches its own failures.
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import { query } from '../db/index.js';
import { LAYOUT_ENGINE_VERSION, layoutFingerprint, PRINTABLE_RENDERER_VERSIONS } from '../render/index.js';
import { carriedDiagnosticClass, classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
import { letterParams, postcardParams } from './letterJobService.js';
import { drawPrintPdf, letterPages, letterPrintLayout, postcardPrintLayout, RenderRefusal, type PrintLayout } from './printDocument.js';
import { drawnByRenderer } from './providers/extraServices.js';
import { deleteHeldPdf, listHeldPdfs, storeHeldPdf } from './tempImageStore.js';
import type { Letter } from './types.js';

/**
 * How long a stored PDF may wait for its row to record it, and how long after
 * its send a held letter is left to the send's own store before the backfill
 * draws one: the sweep never deletes a PDF younger than this, so it cannot
 * take one between its upload and its row's update.
 */
export const HELD_PDF_GRACE_MS = 15 * 60_000;

/** The most held letters one maintenance run draws a PDF for. */
const BACKFILL_LIMIT = 50;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const errorClassOf = (error: unknown) =>
  error instanceof RenderRefusal ? error.reason : carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'unknown_error');

const kindOf = (letter: Pick<Letter, 'mail_type'>): 'letter' | 'postcard' =>
  (letter.mail_type || 'letter') === 'postcard' ? 'postcard' : 'letter';

/**
 * The layout the print will draw for this letter or postcard, as the print
 * builds it from the row (letterJobService's params, printDocument's layout).
 * A RenderRefusal for mail the print would refuse too.
 */
export function printLayoutOf(letter: Letter): PrintLayout {
  const renderer = (letter.content as Record<string, unknown> | null)?.rendererVersion;
  if (typeof renderer !== 'string' || !PRINTABLE_RENDERER_VERSIONS.has(renderer)) {
    throw new RenderRefusal('unknown_version', 'This build cannot print the renderer version the mail records.');
  }
  // No provider call is made from these params: the key is never read.
  const job = { idempotency_key: '' };
  if (kindOf(letter) === 'postcard') {
    const params = postcardParams(letter, job);
    // As PostGrid reads it, and refused as it refuses a size no writer stores.
    const size = params.size || '6x9';
    if (!(['6x4', '6x9', '6x11'] as const).includes(size)) {
      throw new RenderRefusal('size', 'A postcard cannot be printed at the size it records.');
    }
    return postcardPrintLayout(params, size);
  }
  const params = letterParams(letter, job);
  return letterPrintLayout(params, letterPages(params, true));
}

/**
 * In the send's transaction, for mail held for its date (`releaseAt` after
 * `now`) that our renderer draws: record the fingerprint of what the print
 * will lay out, and the engine. Mail it cannot lay out is left unrecorded,
 * and prints, or is held, as it would have been. Under a savepoint, so a
 * failed write never aborts the send; only a connection too broken to roll
 * back to it throws, and the send could not commit then anyway.
 */
export async function recordHeldPrintWithClient(
  client: Pick<pg.PoolClient, 'query'>,
  letter: Letter,
  releaseAt: Date | undefined,
  now: Date = new Date()
): Promise<void> {
  if (!releaseAt || releaseAt.getTime() <= now.getTime()) return;
  if (!drawnByRenderer(letter.content)) return;
  let fingerprint: string;
  try {
    const print = printLayoutOf(letter);
    fingerprint = layoutFingerprint(print.layout, print.rendererVersion);
  } catch (error) {
    writeDiagnostic('warn', 'held_print.not_recorded', { letterId: letter.letter_id, errorClass: errorClassOf(error) });
    return;
  }
  await client.query('SAVEPOINT held_print');
  try {
    await client.query(
      `UPDATE letters SET print_layout_fingerprint = $2, print_layout_engine = $3 WHERE letter_id = $1`,
      [letter.letter_id, fingerprint, LAYOUT_ENGINE_VERSION]
    );
    await client.query('RELEASE SAVEPOINT held_print');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT held_print');
    writeDiagnostic('error', 'held_print.not_recorded', { letterId: letter.letter_id, errorClass: errorClassOf(error) });
  }
}

export type StoreHeldPrintOutcome = 'stored' | 'skipped' | 'layout_changed' | 'unprintable' | 'failed';

/**
 * Draw a held letter's PDF and keep it, once its send has committed. Only for
 * a letter still queued for its date, unredacted, fingerprinted and without a
 * stored PDF, whose layout is still the one recorded; its SHA-256 is recorded
 * only after the upload succeeded, and the object is deleted again when the
 * letter stopped waiting meanwhile. Never throws.
 */
export async function storeHeldPrint(letterId: string): Promise<StoreHeldPrintOutcome> {
  try {
    const letter = (await query<Letter>('SELECT * FROM letters WHERE letter_id = $1', [letterId])).rows[0];
    if (
      !letter ||
      letter.status !== 'queued' ||
      !letter.mail_on ||
      letter.redacted_at ||
      !letter.print_layout_fingerprint ||
      letter.print_pdf_sha256
    ) {
      return 'skipped';
    }
    const print = printLayoutOf(letter);
    if (layoutFingerprint(print.layout, print.rendererVersion) !== letter.print_layout_fingerprint) {
      // A deploy since the send lays it out otherwise: the print will hold it.
      // Said now, while there is time before its date to act.
      writeDiagnostic('error', 'held_print.layout_changed', { letterId });
      return 'layout_changed';
    }
    const pdf = await drawPrintPdf(print, kindOf(letter));
    const digest = sha256(pdf);
    if (!(await storeHeldPdf(letterId, pdf))) return 'skipped';
    // A store running beside another (the send's, late, and the backfill's) draws the same bytes, so a
    // row already recording this digest is this object's too, and keeps it.
    const recorded = await query(
      `UPDATE letters SET print_pdf_sha256 = $2
        WHERE letter_id = $1
          AND (print_pdf_sha256 IS NULL OR print_pdf_sha256 = $2)
          AND print_layout_fingerprint = $3
          AND status = 'queued'
          AND mail_on IS NOT NULL
          AND redacted_at IS NULL`,
      [letterId, digest, letter.print_layout_fingerprint]
    );
    if ((recorded.rowCount ?? 0) === 0) {
      // It stopped waiting, or changed, between the read and the upload, or records other bytes.
      await deleteHeldPdf(letterId);
      return 'skipped';
    }
    return 'stored';
  } catch (error) {
    // Our renderer refusing this letter is the letter's, and the print will hold it the same way; anything
    // else (the bucket, the database) is the store's, and fails the next letter too.
    if (error instanceof RenderRefusal) {
      writeDiagnostic('error', 'held_print.unprintable', { letterId, errorClass: error.reason });
      return 'unprintable';
    }
    writeDiagnostic('error', 'held_print.store_failed', { letterId, errorClass: errorClassOf(error) });
    return 'failed';
  }
}

/**
 * The maintenance run's store for held letters the send could not store a PDF
 * for (a bucket outage, a crash after the commit, Pay & Send's fulfilment,
 * which commits elsewhere): fingerprinted, still queued, sent more than the
 * grace ago and due more than the grace from now. A letter whose layout has
 * changed is reported, never stored.
 */
export async function backfillHeldPrints(): Promise<{ stored: number; layoutChanged: number; unprintable: number; failed: number }> {
  const due = await query<{ letter_id: string }>(
    `SELECT l.letter_id
       FROM letters l
       JOIN letter_jobs j ON j.letter_id = l.letter_id
      WHERE l.status = 'queued'
        AND l.mail_on IS NOT NULL
        AND l.redacted_at IS NULL
        AND l.print_layout_fingerprint IS NOT NULL
        AND l.print_pdf_sha256 IS NULL
        AND l.created_at < NOW() - make_interval(secs => $1)
        AND j.status = 'pending'
        AND j.mail_hold_until IS NOT NULL
        AND j.next_attempt_at > NOW() + make_interval(secs => $1)
      ORDER BY j.next_attempt_at
      LIMIT $2`,
    [HELD_PDF_GRACE_MS / 1000, BACKFILL_LIMIT]
  );
  const summary = { stored: 0, layoutChanged: 0, unprintable: 0, failed: 0 };
  for (const row of due.rows) {
    const outcome = await storeHeldPrint(row.letter_id);
    if (outcome === 'stored') summary.stored += 1;
    else if (outcome === 'layout_changed') summary.layoutChanged += 1;
    // A letter our renderer refuses is the letter's own: the rest are tried.
    else if (outcome === 'unprintable') summary.unprintable += 1;
    else if (outcome === 'failed') {
      // A bucket or database that failed once fails the rest the same way, each after its time limit:
      // the next run tries again, rather than this one holding up the tasks after it.
      summary.failed += 1;
      break;
    }
  }
  return summary;
}

/**
 * Delete every held PDF older than the grace whose letter no longer waits to
 * print with it: accepted by the provider, cancelled, failed, erased, emptied
 * by retention, or no longer recording it. A letter still queued, being
 * dispatched, or held for an operator after an unclear dispatch keeps its PDF,
 * so a retry prints the same bytes.
 */
export async function sweepHeldPdfs(now: Date = new Date()): Promise<{ kept: number; deleted: number }> {
  const stored = await listHeldPdfs();
  const old = stored.filter((entry) => entry.storedAt.getTime() + HELD_PDF_GRACE_MS <= now.getTime());
  if (old.length === 0) return { kept: stored.length, deleted: 0 };
  const waiting = await query<{ letter_id: string }>(
    `SELECT letter_id FROM letters
      WHERE letter_id = ANY($1::text[])
        AND status IN ('queued', 'processing', 'held')
        AND print_pdf_sha256 IS NOT NULL
        AND redacted_at IS NULL`,
    [old.map((entry) => entry.letterId)]
  );
  const keep = new Set(waiting.rows.map((row) => row.letter_id));
  let deleted = 0;
  for (const entry of old) {
    if (keep.has(entry.letterId)) continue;
    await deleteHeldPdf(entry.letterId);
    deleted += 1;
  }
  return { kept: stored.length - deleted, deleted };
}

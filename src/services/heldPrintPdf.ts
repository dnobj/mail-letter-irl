/**
 * The print's side of held mail's stored PDF (#697): read before the print,
 * checked against the SHA-256 the send recorded, and deleted once the
 * provider has the mail. Apart from heldPrintService, which builds the print's
 * params from letterJobService, so neither imports the other.
 */

import { createHash } from 'node:crypto';
import { carriedDiagnosticClass, classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';
import { deleteHeldPdf, getHeldPdf } from './tempImageStore.js';
import type { Letter } from './types.js';

const errorClassOf = (error: unknown) => carriedDiagnosticClass(error) ?? classifyDiagnosticError(error, 'unknown_error');

/**
 * The PDF the send stored for this letter, when its bytes are the ones it
 * recorded; undefined otherwise, and for a store that cannot be read, so the
 * print lays the letter out again under its fingerprint. Never throws.
 */
export async function storedHeldPdf(letter: Pick<Letter, 'letter_id' | 'print_pdf_sha256'>): Promise<Buffer | undefined> {
  if (!letter.print_pdf_sha256) return undefined;
  try {
    const pdf = await getHeldPdf(letter.letter_id);
    if (!pdf) {
      writeDiagnostic('warn', 'held_print.pdf_missing', { letterId: letter.letter_id });
      return undefined;
    }
    if (createHash('sha256').update(pdf).digest('hex') !== letter.print_pdf_sha256) {
      writeDiagnostic('error', 'held_print.pdf_mismatch', { letterId: letter.letter_id });
      return undefined;
    }
    return pdf;
  } catch (error) {
    writeDiagnostic('warn', 'held_print.pdf_unreadable', { letterId: letter.letter_id, errorClass: errorClassOf(error) });
    return undefined;
  }
}

/** Forget a letter's held PDF, if any: the sweep retries what this cannot. Never throws. */
export async function forgetHeldPdf(letterId: string): Promise<void> {
  try {
    await deleteHeldPdf(letterId);
  } catch (error) {
    writeDiagnostic('warn', 'held_print.delete_failed', { letterId, errorClass: errorClassOf(error) });
  }
}

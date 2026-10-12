import type { DraftOptionRow } from '../../src/services/mailOptions.js';

/**
 * A draft's option columns as a reader selects them (#691): each one not given is the
 * column's null, which draftMailOption reads as a missing one always was read.
 */
export function optionRow(row: { [K in keyof DraftOptionRow]?: DraftOptionRow[K] }): DraftOptionRow {
  return {
    mail_type: row.mail_type ?? null,
    postcard_size: row.postcard_size ?? null,
    pages: row.pages ?? null,
    mail_service: row.mail_service ?? null
  };
}

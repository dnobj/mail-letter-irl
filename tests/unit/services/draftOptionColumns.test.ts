import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #625. A draft's price depends on its mail type, its pages and its mail
 * service (draftMailOption), so a reader that loads some columns of the row but
 * not all of them prices a certified letter as a standard one: the partial-row
 * defect that `pages` already had. This reads the SOURCE: any query that names
 * its columns, selects from letter_drafts and picks up `pages` must pick up
 * `mail_service` too.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Every `SELECT <columns> FROM letter_drafts` in the source, with where it is. */
function draftSelects(): Array<{ file: string; columns: string }> {
  const found: Array<{ file: string; columns: string }> = [];
  for (const file of sourceFiles('src')) {
    const text = readFileSync(file, 'utf8');
    // The nearest SELECT before the table: a capture that crosses another SELECT would swallow a whole file.
    for (const match of text.matchAll(/SELECT\s+((?:(?!\bSELECT\b)[\s\S])*?)\s+FROM\s+letter_drafts\b/gi)) {
      found.push({ file: file.split(String.fromCharCode(92)).join('/'), columns: match[1] });
    }
  }
  return found;
}

describe('the draft columns a price is read from (#625)', () => {
  it('finds the queries it is guarding', () => {
    // If the source layout or the query shape changes, fail loudly rather than guard nothing.
    expect(draftSelects().length).toBeGreaterThanOrEqual(8);
    expect(draftSelects().some(select => /\bpages\b/.test(select.columns))).toBe(true);
  });

  it('never selects pages without mail_service', () => {
    const partial = draftSelects()
      .filter(select => select.columns.trim() !== '*' && /\bpages\b/.test(select.columns))
      .filter(select => !/\bmail_service\b/.test(select.columns))
      .map(select => `${select.file}: ${select.columns.replace(/\s+/g, ' ').slice(0, 120)}`);
    expect(partial, 'these queries read the pages of a draft but not how it travels').toEqual([]);
  });

  it('selects the whole row where it prices a draft by SELECT *', () => {
    // The checkout and the send lock the row with SELECT * ... FOR UPDATE: a column list there would be the same defect.
    const whole = draftSelects().filter(select => select.columns.trim() === '*').map(select => select.file);
    expect(whole).toContain('src/services/commerceService.ts');
    expect(whole).toContain('src/services/mailSendService.ts');
  });
});

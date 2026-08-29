import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `last_error_code` and `last_error` must be written together (#279).
 *
 * Three separate review rounds each found one `UPDATE orders` that set the code
 * and left the message untouched, and each was fixed by hand:
 *
 *   round 12 - the sibling in prepareJitOrder
 *   round 13 - the reprice-cancel branch
 *   #279     - the unmatched-money recovery branch
 *
 * The consequence is always the same: an operator triaging stranded money reads
 * a fresh code beside a stale, unrelated message, and believes the two describe
 * one event. Fixing the third site by hand would only queue up a fourth, so the
 * invariant is asserted here instead.
 *
 * A TEXTUAL test is the right shape for this one, unlike most. The defect is
 * literally an absent column in a statement, so reading the statement is
 * reading the defect. That is not true of the semantic cases - #278 round 14
 * caught a grep-based test passing while the branch it guarded had been
 * replaced with a no-op - so this stays narrow: it makes no claim about what
 * the values mean, only that both columns appear in the same statement.
 */

const SOURCE = new URL('../../../src/services/commerceService.ts', import.meta.url);

/** Every template-literal SQL statement in the file. */
function sqlStatements(): string[] {
  const source = readFileSync(SOURCE, 'utf8');
  const found: string[] = [];
  // Template literals only: every SQL statement in this file is written as one,
  // and a naive line scan would split multi-line statements apart.
  const pattern = /`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  return found;
}

/**
 * `last_error` as its own column, never the prefix of `last_error_code`.
 * `_` is a word character, so \b will not match between the two.
 */
const SETS_MESSAGE = /\blast_error\s*=/;
const SETS_CODE = /\blast_error_code\s*=/;

describe('order error columns are written in pairs', () => {
  const statements = sqlStatements().filter(sql => /UPDATE\s+orders/i.test(sql));

  it('finds the statements it is guarding', () => {
    // If commerceService stops writing SQL as template literals, this must fail
    // loudly rather than silently guard nothing.
    expect(statements.length).toBeGreaterThan(5);
    expect(statements.filter(sql => SETS_CODE.test(sql)).length).toBeGreaterThan(2);
  });

  it('never sets last_error_code without also setting last_error', () => {
    const unpaired = statements
      .filter(sql => SETS_CODE.test(sql) && !SETS_MESSAGE.test(sql))
      // Collapse whitespace so the failure names the statement readably.
      .map(sql => sql.replace(/\s+/g, ' ').trim().slice(0, 120));

    expect(
      unpaired,
      `these UPDATE orders statements set a code with no message:\n  ${unpaired.join('\n  ')}`
    ).toEqual([]);
  });

  it('distinguishes the two columns rather than matching a prefix', () => {
    // The regex above is the whole test. If \b stopped excluding
    // `last_error_code`, every statement would look paired and the guard would
    // pass on the very defect it exists to catch.
    expect(SETS_MESSAGE.test('SET last_error_code = $1')).toBe(false);
    expect(SETS_MESSAGE.test('SET last_error = $1')).toBe(true);
    expect(SETS_MESSAGE.test('SET last_error_code = $1, last_error = $2')).toBe(true);
    expect(SETS_CODE.test('SET last_error = $1')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain Node script, with no type declarations
import { ratchet, typeErrors } from '../../../scripts/check-test-types.mjs';

/**
 * The ratchet on the tests' type errors (#686): a rise fails, a fall lowers
 * the baseline unless only checking, and the same count passes unchanged.
 */
describe('the test type-check ratchet', () => {
  it('fails when the count rises, whether or not only checking', () => {
    expect(ratchet({ count: 278, baseline: 277, checkOnly: false })).toMatchObject({ fail: true, baseline: 277 });
    expect(ratchet({ count: 278, baseline: 277, checkOnly: true })).toMatchObject({ fail: true, baseline: 277 });
  });

  it('passes the same count and keeps the baseline', () => {
    expect(ratchet({ count: 277, baseline: 277, checkOnly: false })).toMatchObject({ fail: false, baseline: 277 });
  });

  it('lowers the baseline when the count falls, but not when only checking', () => {
    expect(ratchet({ count: 270, baseline: 277, checkOnly: false })).toMatchObject({ fail: false, baseline: 270 });
    expect(ratchet({ count: 270, baseline: 277, checkOnly: true })).toMatchObject({ fail: false, baseline: 277 });
  });

  it("counts tsc's error lines and nothing else", () => {
    const output = [
      "tests/a.test.ts(1,2): error TS2345: Argument of type 'x' is not assignable.",
      '  Type x is not assignable to type y.',
      'tests/b.test.ts(3,4): error TS7006: Parameter implicitly has an any type.',
      ''
    ].join('\r\n');
    expect(typeErrors(output)).toHaveLength(2);
  });
});

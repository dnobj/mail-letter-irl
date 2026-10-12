import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain Node script, with no type declarations
import { projectErrors, ratchet, typeErrors } from '../../../scripts/check-test-types.mjs';

/**
 * The ratchet on the tests' type errors (#686): a rise fails, a fall lowers
 * the baseline only when an update is asked for, and the same count passes
 * unchanged. A diagnostic about the project is a failure, never a count.
 */
describe('the test type-check ratchet', () => {
  it('fails when the count rises, whether or not updating', () => {
    expect(ratchet({ count: 278, baseline: 277, update: false })).toMatchObject({ fail: true, baseline: 277 });
    expect(ratchet({ count: 278, baseline: 277, update: true })).toMatchObject({ fail: true, baseline: 277 });
  });

  it('passes the same count and keeps the baseline', () => {
    expect(ratchet({ count: 277, baseline: 277, update: true })).toMatchObject({ fail: false, baseline: 277 });
  });

  it('lowers the baseline when the count falls only on an update, and otherwise says to', () => {
    expect(ratchet({ count: 270, baseline: 277, update: true })).toMatchObject({ fail: false, baseline: 270 });
    const checked = ratchet({ count: 270, baseline: 277, update: false });
    expect(checked).toMatchObject({ fail: false, baseline: 277 });
    expect(checked.message).toMatch(/--update/);
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

  it('takes a missing or broken project, or no inputs, as tsc not having checked the tests', () => {
    const lines = [
      "error TS5058: The specified path does not exist: 'tsconfig.tests.json'.",
      "error TS18003: No inputs were found in config file 'tsconfig.tests.json'.",
      "error TS6053: File 'x.ts' not found.",
      "tests/a.test.ts(1,2): error TS2345: Argument of type 'x' is not assignable."
    ];
    expect(projectErrors(lines)).toHaveLength(3);
    expect(projectErrors([lines[3]])).toHaveLength(0);
    // The same codes on a line of a test are an error in the test, counted like any other.
    expect(projectErrors(["tests/a.test.ts(1,2): error TS5097: An import path can only end with a '.ts' extension."])).toHaveLength(0);
  });
});

/**
 * Issue #275 stage A deleted the five *_AMOUNT_CENTS variables: amounts come
 * from the Stripe Price itself, and a second copy in the environment is
 * exactly what used to drift. The first attempt at the deletion removed them
 * from the code and ONE of the three example env files, leaving the other two
 * instructing operators to set - and keep manually aligned - variables nothing
 * reads (#278 review). This pins the deletion everywhere an operator copies
 * from, so it cannot be quietly undone file by file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DELETED_VARS = [
  'STRIPE_STARTER_AMOUNT_CENTS',
  'STRIPE_REGULAR_AMOUNT_CENTS',
  'STRIPE_POWER_AMOUNT_CENTS',
  'JIT_LETTER_AMOUNT_CENTS',
  'JIT_POSTCARD_AMOUNT_CENTS'
];

describe('example env files (#275)', () => {
  const exampleFiles = readdirSync('.').filter(
    name => name.startsWith('.env') && name.endsWith('.example')
  );

  it('finds the example files it is guarding', () => {
    // If the naming convention changes, this test must fail loudly rather
    // than guard nothing.
    expect(exampleFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of ['.env.example', '.env.dev.example', '.env.test.example']) {
    it(`${file} sets no deleted amount variable`, () => {
      const content = readFileSync(file, 'utf8');
      for (const name of DELETED_VARS) {
        // A KEY= line is what an operator would copy; a mention in a comment
        // explaining the deletion is fine.
        expect(content).not.toMatch(new RegExp(`^${name}=`, 'm'));
      }
    });
  }
});

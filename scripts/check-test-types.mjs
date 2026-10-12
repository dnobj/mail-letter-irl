#!/usr/bin/env node
/**
 * The tests' type errors may only fall (#686). `npm run build` type-checks
 * src alone, so a test that calls a changed function the wrong way runs
 * until CI's tests meet it, or never fails at all. Fixing all of them at once
 * is a large change of its own, so this holds the count where it is: more
 * errors than the committed baseline fail; fewer lower the baseline, and the
 * new one is committed with the change that fixed them.
 *
 *   node scripts/check-test-types.mjs           check, and lower the baseline when it falls
 *   node scripts/check-test-types.mjs --check   check only (CI): never rewrites the baseline
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * What a count means against the baseline: fail when it rose, lower the
 * baseline when it fell (unless only checking), and say which.
 */
export function ratchet({ count, baseline, checkOnly }) {
  if (count > baseline) {
    return { fail: true, baseline, message: `Test type errors rose from ${baseline} to ${count}.` };
  }
  if (count < baseline && !checkOnly) {
    return {
      fail: false,
      baseline: count,
      message: `Test type errors fell from ${baseline} to ${count}: the baseline is now ${count}. Commit scripts/test-types-baseline.json.`
    };
  }
  return { fail: false, baseline, message: `Test type errors: ${count} (baseline ${baseline}).` };
}

/** The type errors in tsc's output, one line each. */
export function typeErrors(output) {
  return output.split(/\r?\n/).filter(line => /error TS\d+:/.test(line));
}

function main() {
  const BASELINE_FILE = new URL('./test-types-baseline.json', import.meta.url);
  const checkOnly = process.argv.includes('--check');

  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.tests.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout}${run.stderr}`;
  const errors = typeErrors(output);
  if (run.status !== 0 && errors.length === 0) {
    console.error('tsc failed without reporting type errors:');
    console.error(output.split(/\r?\n/).slice(0, 20).join('\n'));
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).errors;
  const verdict = ratchet({ count: errors.length, baseline, checkOnly });
  if (verdict.fail) {
    const byFile = new Map();
    for (const line of errors) {
      const file = line.replace(/\(.*$/, '');
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
    }
    console.error(`${verdict.message} Files with errors:`);
    for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.error(`  ${n}  ${file}`);
    console.error('Run "npx tsc -p tsconfig.tests.json" to see them; fix the new ones.');
    process.exit(1);
  }
  if (verdict.baseline !== baseline) {
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ errors: verdict.baseline }, null, 2)}\n`);
  }
  console.log(verdict.message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

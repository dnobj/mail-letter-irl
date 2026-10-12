/**
 * The tests' type errors may only fall (#686). `npm run build` type-checks
 * src alone, so a test that calls a changed function the wrong way runs
 * until CI's tests meet it, or never fails at all. Fixing all of them at once
 * is a large change of its own, so this holds the count where it is: more
 * errors than the committed baseline fail. After fixing some, lower the
 * baseline on purpose with --update and commit it with the fix.
 *
 *   node scripts/check-test-types.mjs            check (npm run verify, CI): never writes
 *   node scripts/check-test-types.mjs --update   check, and lower the baseline when the count fell
 *
 * The check runs a whole tsc over src and tests: about 90 s and over 3 GB on
 * this codebase today, so it is given a larger heap than Node's default.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEAP_MB = 6144;

/**
 * What a count means against the baseline: fail when it rose, lower the
 * baseline when it fell and an update was asked for, and say which.
 */
export function ratchet({ count, baseline, update }) {
  if (count > baseline) {
    return { fail: true, baseline, message: `Test type errors rose from ${baseline} to ${count}.` };
  }
  if (count < baseline && update) {
    return {
      fail: false,
      baseline: count,
      message: `Test type errors fell from ${baseline} to ${count}: the baseline is now ${count}. Commit scripts/test-types-baseline.json.`
    };
  }
  const fell = count < baseline ? ' They fell: run with --update to lower the baseline, and commit it.' : '';
  return { fail: false, baseline, message: `Test type errors: ${count} (baseline ${baseline}).${fell}` };
}

/** The type errors in tsc's output, one line each. */
export function typeErrors(output) {
  return output.split(/\r?\n/).filter(line => /error TS\d+:/.test(line));
}

/**
 * Diagnostics about the project rather than the code (a missing or broken
 * tsconfig, no inputs, a bad option): tsc did not check the tests at all, so
 * they are a failure, never a count. TS5xxx are option errors, TS6xxx project
 * and file errors, TS18003 "No inputs were found". Only a line with no file
 * location: the same codes reported on a line of a test are counted.
 */
export function projectErrors(errors) {
  return errors.filter(line => /^error TS(5\d{3}|6\d{3}|18003):/.test(line));
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const baselineFile = join(root, 'scripts', 'test-types-baseline.json');
  const update = process.argv.includes('--update');

  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const run = spawnSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, tsc, '-p', join(root, 'tsconfig.tests.json')],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const output = `${run.stdout}${run.stderr}`;
  const errors = typeErrors(output);
  const broken = projectErrors(errors);
  if ((run.status !== 0 && errors.length === 0) || broken.length > 0 || run.error) {
    console.error('tsc did not check the tests:');
    console.error((broken.length > 0 ? broken : output.split(/\r?\n/).slice(0, 20)).join('\n') || String(run.error));
    process.exit(1);
  }

  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')).errors;
  const verdict = ratchet({ count: errors.length, baseline, update });
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
    writeFileSync(baselineFile, `${JSON.stringify({ errors: verdict.baseline }, null, 2)}\n`);
  }
  console.log(verdict.message);
}

// Run as a script, whatever path or link it was started by; imported by its test, it runs nothing.
let started = '';
try {
  started = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {
  // Started by a path that is not there (another tool's runner): not run as a script.
}
if (started && realpathSync(fileURLToPath(import.meta.url)) === started) main();

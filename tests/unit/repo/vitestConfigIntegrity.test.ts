import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config.js';

/**
 * The test runner's own configuration, guarded (#285).
 *
 * `vitest.config.ts` carried `singleFork: true` for months. It was never a
 * Vitest 4 option at the top level of `test` - it belonged under
 * `poolOptions.forks` in v2/v3, and `poolOptions` was removed in v4 - so Vite
 * passed the unknown key straight through and the integration suites ran in
 * PARALLEL, the exact opposite of what the line said they did. The cost was
 * real: src/cli/migrate.ts takes a DATABASE-scoped advisory lock, and
 * migrateConcurrency.postgres.test.ts holds that same lock for a full 60s
 * against the same database every other suite migrates into.
 *
 * WHY THIS IS A TEST AND NOT A TSCONFIG. Type-checking cannot catch it. All
 * three of these were verified to compile clean against `vitest.config.ts`:
 *
 *   singleFork: true                  // dead option
 *   totallyMadeUpNonsenseKey: 42      // not an option at all
 *   testTimeout: 'ten thousand'       // real option, wrong type
 *
 * `defineConfig` accepts a union, which disables excess-property checking;
 * annotating the literal as `ViteUserConfig` first does not restore it; and
 * spreading a plain object into a typed target defeats it a third time. A
 * `tsconfig.test.json` covering this file passes on every one of the above,
 * which makes it a guard that cannot fail - worse than no guard, because it
 * looks like one.
 *
 * So this imports the resolved config and asserts its shape.
 */
describe('vitest configuration integrity (#285)', () => {
  const test = (config as { test?: Record<string, unknown> }).test ?? {};
  const projects = (test.projects ?? []) as Array<{ test?: Record<string, unknown> }>;

  function project(name: string): Record<string, unknown> {
    const found = projects.find(entry => entry.test?.name === name);
    if (!found?.test) throw new Error(`no project named ${name}`);
    return found.test;
  }

  it('serialises the integration lane', () => {
    // The assertion this file exists for. Removing it, or renaming the option
    // to something Vitest ignores, reddens here.
    expect(project('integration').fileParallelism).toBe(false);
  });

  it('leaves the unit lane parallel', () => {
    // Serialising 89 database-free files costs 7.6s -> 34.1s, measured. The
    // fast lane's whole value is the speed, so this is not a free default to
    // let drift.
    expect(project('unit').fileParallelism).toBeUndefined();
  });

  it('gives every project its own setupFiles', () => {
    // A root-level setupFiles does NOT cascade into projects - verified
    // empirically. A project without it never runs tests/setup.ts, losing the
    // NODE_ENV=test that validateDisposableDatabaseUrl's production guard
    // reads, and the failure would surface as a confusing database error
    // rather than as a missing setup file.
    expect(projects).toHaveLength(2);
    for (const entry of projects) {
      expect(entry.test?.setupFiles).toEqual(['./tests/setup.ts']);
    }
  });

  it('routes each lane to its own directory, with nothing unclaimed', () => {
    expect(project('unit').include).toEqual(['tests/unit/**/*.test.ts']);
    expect(project('integration').include).toEqual(['tests/integration/**/*.test.ts']);
  });

  it('carries no option Vitest 4 silently ignores', async () => {
    // Textual, deliberately: these are keys that type-check clean and do
    // nothing, so only their absence from the source proves they are gone.
    // `poolOptions` is included because it is where singleFork legitimately
    // lived in v2/v3, and is the most likely wrong turn for someone trying to
    // restore the old behaviour.
    const source = await readFile(new URL('../../../vitest.config.ts', import.meta.url), 'utf8');
    const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(body).not.toMatch(/\bsingleFork\b/);
    expect(body).not.toMatch(/\bpoolOptions\b/);
    // A WSL absolute path for a differently-named checkout, resolving nothing.
    expect(body).not.toMatch(/mnt\/c\/letter-irl/);
  });
});

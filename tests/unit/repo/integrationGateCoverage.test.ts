import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * AGENTS.md makes `npm run test:integration:postgres` a REQUIRED gate for any
 * change to financial, fulfillment, refund, entitlement, migration or admin
 * state, and requires the PR to report its actual pass count.
 *
 * For most of this repository's life that command ran ONE of the eight
 * PostgreSQL suites - commerceAcid - while CI and the local runner both ran the
 * whole directory. So every PR that reported the required gate green was
 * reporting on a fraction of it, and none of the dispute-revocation,
 * refund-finalization, failed-send-refund or migration-concurrency suites were
 * covered by the gate their own subject matter is named in.
 *
 * These assertions exist because the divergence was invisible: each command
 * looked reasonable on its own line, and nothing compared them.
 */
describe('the required integration gate covers what CI covers (#156)', () => {
  async function scripts(): Promise<Record<string, string>> {
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> };
    return pkg.scripts;
  }

  it('runs the same target as the unqualified integration command', async () => {
    const { 'test:integration': all, 'test:integration:postgres': gate } = await scripts();

    expect(gate).toBe(all);
  });

  it('targets the directory, not a single suite', async () => {
    const { 'test:integration:postgres': gate } = await scripts();

    // A path ending in .test.ts is one file, which is how this drifted.
    expect(gate).not.toMatch(/\.test\.ts\s*$/);
    expect(gate).toContain('tests/integration');
  });

  it('matches what CI actually executes', async () => {
    const [{ 'test:integration:postgres': gate }, workflow] = await Promise.all([
      scripts(),
      readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    ]);

    // CI is the source of truth for what "the suite passed" means; the gate a
    // contributor is told to run locally has to mean the same thing.
    expect(workflow).toContain('npm run test:integration ');
    expect(gate).toContain('tests/integration');
  });

  it('matches what the documented local runner executes', async () => {
    const runner = await readFile(
      new URL('../../../scripts/run-integration-local.ts', import.meta.url),
      'utf8'
    );

    expect(runner).toContain("'tests/integration',");
  });
});

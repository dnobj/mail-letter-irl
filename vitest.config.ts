import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the two lanes need opposite parallelism.
 *
 * The unit lane is 89 files that touch no database, and its whole value is a
 * fast signal - serialising it costs 7.6s -> 34.1s, measured. The integration
 * lane must NOT run its files in parallel: src/cli/migrate.ts takes
 * pg_advisory_xact_lock, which is DATABASE-scoped rather than schema-scoped,
 * and migrateConcurrency.postgres.test.ts deliberately holds that same lock for
 * a full 60s lock_timeout against the same letterirl_test database every other
 * suite migrates into. Any suite reaching migrate() inside that window dies
 * with SQLSTATE 55P03 and takes its whole file with it (#285).
 *
 * This replaces `singleFork: true`, which was never a Vitest 4 option at the top
 * level of `test` - it belonged under `poolOptions.forks` in v2/v3, and
 * `poolOptions` was removed in v4. It silently did nothing, and the integration
 * suites have been running in parallel against this file's stated intent ever
 * since.
 *
 * NOTHING IN TYPESCRIPT CATCHES THAT. Verified, three ways: `defineConfig`
 * takes a union, which disables excess-property checking; annotating the
 * literal as `ViteUserConfig` first does not restore it; and spreading a
 * plain object into a typed target defeats it again. `singleFork: true`,
 * `totallyMadeUpNonsenseKey: 42` and even `testTimeout: 'ten thousand'` all
 * type-check clean. The guard is therefore a test -
 * tests/unit/repo/vitestConfigIntegrity.test.ts - which imports this file and
 * asserts its resolved shape. Do not replace it with a tsconfig.
 *
 * Every option each project needs is repeated rather than inherited: a root
 * `setupFiles` does NOT cascade into projects - verified empirically, a project
 * without it never runs tests/setup.ts and would therefore lose the
 * NODE_ENV=test that validateDisposableDatabaseUrl's production guard reads.
 * `coverage` is the exception: it is a non-project option and stays at the root.
 *
 * `pool: 'forks'` is gone because it is already the Vitest 4 default.
 */
const shared = {
  globals: true,
  environment: 'node' as const,
  setupFiles: ['./tests/setup.ts'],
  testTimeout: 10_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          ...shared,
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // The whole point of this file. See the header.
          fileParallelism: false,
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/mcp/**',  // MCP server entry points
        'src/cli/**',  // CLI tools
        '**/*.d.ts',
      ],
    },
  },
});

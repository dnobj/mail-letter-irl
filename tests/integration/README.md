# Disposable PostgreSQL ACID tests

`commerceAcid.postgres.test.ts` is an opt-in integration suite for the financial
and fulfillment transaction boundaries introduced by issue #69. It applies the
real migrations and exercises database constraints, concurrent row claims,
rollback/replay, refund leases, dispute-alert durability, and image-reservation
recovery.

Run it only against a disposable PostgreSQL database:

```powershell
$env:LIRL_RUN_POSTGRES_INTEGRATION = 'true'
$env:LIRL_TEST_DATABASE_URL = 'postgresql://postgres:password@127.0.0.1:5432/letterirl_acid_test'
npm run test:integration:postgres
```

The suite fails closed unless the host is local, the database name contains
`test` or `acid`, `NODE_ENV` is not production, and the URL differs from the
application `DATABASE_URL`. It creates and drops only generated schemas whose
names begin with `lirl_acid_`.

The migration-order case runs the actual migrator in both supported sequences:
`021 -> 023 -> later 022` and `021 -> 022 -> 023`. It reads the real
`022_admin_audit.sql` from `db/migrations` and refuses to run against a synthetic
substitute. While issue #162's branch is stacked on issue #69, that file is
present in this repository, so both sequences now use the reviewed 022.

## Concurrent migrator tests

`migrateConcurrency.postgres.test.ts` reproduces the PR #164 / PR #165 Railway
failure, where two queued deploys each ran `npm run db:migrate:prod` against the
same database and the second one died. It shares the same gate and the same
fail-closed URL validation as the ACID suite:

```powershell
$env:LIRL_RUN_POSTGRES_INTEGRATION = 'true'
$env:LIRL_TEST_DATABASE_URL = 'postgresql://postgres:password@127.0.0.1:5432/letterirl_migrate_test'
npx vitest run tests/integration/migrateConcurrency.postgres.test.ts
```

It copies the real `db/migrations` into a scratch directory (never writing to
them) and appends a probe migration whose `CREATE TABLE` is guarded with
`IF NOT EXISTS` but whose `INSERT` is not, so a migration body applied twice
shows up as two rows rather than an error. Coverage:

- two concurrent in-process migrators against one fresh schema,
- a third migrator afterwards, which must be a no-op,
- a failing migration, which must release the advisory lock so the next
  migrator still runs, and must rethrow PostgreSQL's own error annotated with
  `migrationFile`,
- two real `node dist/cli/migrate.js` processes racing, exactly as Railway
  invokes them (this case builds `dist` via `tsc` in `beforeAll`),
- a failing CLI run, which must exit 1 and log the failing filename while
  keeping the PostgreSQL message redacted.

Against the pre-fix migrator every case fails, most often with
`duplicate key value violates unique constraint "pg_class_relname_nsp_index"`
or `"pg_type_typname_nsp_index"` — two processes creating the same table at the
same instant. It creates and drops only generated schemas named `lirl_migrate_*`.

## Admin foundation and arrival-order tests

`admin/adminFoundationDatabase.test.ts` and `admin/adminMigrationOrder.test.ts`
are gated on `LETTER_IRL_ADMIN_TEST_DATABASE_URL` and require a loopback
database whose name contains `test`:

```powershell
$env:LETTER_IRL_ADMIN_TEST_DATABASE_URL = 'postgresql://postgres:password@127.0.0.1:5432/letter_irl_admin_test'
npx vitest run tests/integration/admin
```

`adminMigrationOrder.test.ts` drives the real repository migrator over
`001-020 -> 021 -> 022`, `001-020 -> 021 -> 023 -> 022`, and
`001-020 -> 021 -> 022 -> 023`, then compares columns, constraints, defaults,
indexes, triggers, functions, and table privileges. Both files read migration 021
and 022 only from `db/migrations`; neither accepts an external path override.

The reviewed migration content identities and the resulting integration gate are
recorded in
[`docs/deployment.md`](../../docs/deployment.md#migration-021022023-integration-gate).

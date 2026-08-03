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

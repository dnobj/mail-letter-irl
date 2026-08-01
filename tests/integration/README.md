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
`021 -> 023 -> later 022` and `021 -> 022 -> 023`. When no repository 022 exists,
the test creates a synthetic sequence probe. That proves the migrator records a
lower-numbered late arrival, but it does **not** prove compatibility with issue
#162. Before #69 and #162 integrate or deploy, place the real
`022_admin_audit.sql` in the test input, rerun both sequences, and require the
migration ledger and resulting schema fingerprint to match.

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
- a failing migration, which must roll the **entire** run back — on a fresh
  schema not even the `migrations` ledger table survives — and must rethrow
  PostgreSQL's own error annotated with `migrationFile`, after which a rerun
  completes cleanly,
- a migrator that finds the advisory lock already held, which must fail with
  `55P03` inside its `lock_timeout` rather than hang (a regression here shows
  up as a *test timeout*, not an assertion failure — that is the point),
- two real `node dist/cli/migrate.js` processes racing, exactly as Railway
  invokes them (this case builds `dist` via `tsc` in `beforeAll`),
- a failing CLI run, which must exit 1 and log the failing filename while
  keeping the PostgreSQL message redacted.

Against the pre-fix migrator every case fails, most often with
`duplicate key value violates unique constraint "pg_class_relname_nsp_index"`
or `"pg_type_typname_nsp_index"` — two processes creating the same table at the
same instant. It creates and drops only generated schemas named `lirl_migrate_*`.

The lock-timeout case waits out the real 60s bound, so this file takes a little
over a minute.

### What this file deliberately does NOT cover

It connects **directly** to PostgreSQL, so it cannot observe connection-pooler
behaviour of any kind. Production's `DATABASE_URL` is a Neon `-pooler`
hostname. An earlier revision of the migrator was green on every case here and
still broken in production, because it used a session-scoped advisory lock that
orphans itself under transaction pooling. Anything that depends on pooler
semantics belongs in the pooled suite below, not here.

## Pooled (PgBouncer) migrator tests

`migratePooled.postgres.test.ts` runs the migrator through a real PgBouncer in
`pool_mode = transaction` — production's actual topology. It is what guards the
advisory lock's scope, and it is the only suite that can.

It needs a third variable, and skips silently without it:

```powershell
$env:LIRL_RUN_POSTGRES_INTEGRATION = 'true'
$env:LIRL_TEST_DATABASE_URL   = 'postgresql://postgres:password@127.0.0.1:5432/letterirl_migrate_test'
$env:LIRL_TEST_PGBOUNCER_URL  = 'postgresql://postgres:password@127.0.0.1:6432/letterirl_pooled_test'
npx vitest run tests/integration/migratePooled.postgres.test.ts
```

`LIRL_TEST_DATABASE_URL` must be a **direct** PostgreSQL connection (it is used
to administer databases and to observe `pg_locks` from outside the pooler) and
`LIRL_TEST_PGBOUNCER_URL` must go through PgBouncer; the suite refuses to run if
both point at the same port. Both go through the same fail-closed URL gate as
everything else here. It creates and force-drops only generated databases named
`lirl_pooled_*_test`.

Coverage:

- **the lock-scope proof**: a session-scoped `pg_advisory_lock` taken through
  the pooler is shown to be *orphaned* — the client pool is closed and
  `pg_locks`, observed on a direct connection, still shows the lock held by a
  backend nobody owns, which then blocks the next contender with `55P03`. The
  same sequence with `pg_advisory_xact_lock` leaves nothing behind and the next
  contender acquires immediately,
- two concurrent migrators racing a fresh database through the pooler, ending
  with zero advisory locks held,
- a failed run through the pooler, which must leave no lock behind and no
  partial migration, and whose retry must succeed.

### Measured evidence (why this file is not paranoia)

These are observed results, not predictions. With the **session-scoped**
migrator installed and everything else identical:

- the racing case fails with `relation "migrations" already exists`, **8 runs
  out of 8** — through a transaction pooler a session lock provides *no mutual
  exclusion at all*. Two migrators simply both proceed;
- the direct-connection suite in `migrateConcurrency.postgres.test.ts` is
  **fully green on that same code**. That is the entire point of this file: the
  bug is invisible from a direct connection.

The lock-scope test shows the mechanism directly rather than arguing it. After a
session-scoped `pg_advisory_lock` is taken through the pooler and the client
pool is closed:

- `pg_locks`, read on a *direct* connection, still reports the lock **granted**
  to a backend no client owns any more. The client is gone; the lock is not.
  Nothing will ever release it, because the only thing that could is a backend
  sitting anonymously in PgBouncer's pool;
- the next contender therefore fails `55P03` rather than acquiring — in
  production, without a `lock_timeout`, it would instead hang until the platform
  killed the deploy, and redeploying would not clear it;
- killing that backend with `pg_terminate_backend` is the *only* way to recover.

Repeating the identical sequence with `pg_advisory_xact_lock` leaves `pg_locks`
empty and the next contender acquires immediately. Same pooler, same key, same
client library — the only variable is lock scope.

Against the fixed migrator both suites are green: **8/8** each.

### Standing up PgBouncer

Any PgBouncer in transaction pooling mode works. With Docker:

```bash
docker run -d --name lirl-pgbouncer -p 6432:6432 \
  -e DATABASES_HOST=host.docker.internal -e DATABASES_PORT=5432 \
  -e DATABASES_USER=postgres -e DATABASES_PASSWORD=password \
  -e POOL_MODE=transaction -e AUTH_TYPE=md5 \
  edoburu/pgbouncer
```

Two settings matter and must not be "fixed": `pool_mode = transaction`, and
leaving `server_reset_query_always` at `0` so no `DISCARD ALL` runs between
transactions. Turning either off makes the session-lock leak disappear and the
proof test becomes vacuous. If you route generated per-test databases through
the pooler, give it a wildcard entry (`* = host=... port=...`).

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

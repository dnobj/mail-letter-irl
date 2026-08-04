# Database migrations

`db/migrations/*.sql` are applied in filename order by the migrator in
`src/cli/migrate.ts`. Railway runs it as a pre-deploy command
(`npm run db:migrate:prod`); `npm run db:migrate` runs the same code locally
through the thin wrapper in `db/migrate.ts`.

Applied files are recorded in the `migrations` ledger table by filename, so a
file that has run once is never run again. Migrations are forward-only: there
are no down-migrations, and `npm run db:migrate:rollback` only prints guidance.

## Constraint: every migration must be transaction-safe

**The migrator wraps the ENTIRE run — the ledger table creation, the ledger
read, every pending file, and every ledger insert — in ONE transaction.** It has
to: `DATABASE_URL` is a Neon pooled (`-pooler`) endpoint, which is PgBouncer in
transaction pooling mode, and the advisory lock that stops two concurrent
deploys from racing is only safe there if it is transaction-scoped. See
[Concurrent deploy safety](../docs/deployment.md#concurrent-deploy-safety-migration-advisory-lock).

That buys all-or-nothing semantics, and it imposes one rule on new migrations:

> A migration must not contain a statement that cannot run inside a transaction
> block.

In practice that means **do not use**:

| Statement | Why it breaks |
|---|---|
| `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` | Explicitly cannot run in a transaction block |
| `REINDEX CONCURRENTLY` | Same |
| `VACUUM`, `ANALYZE` in some forms | Cannot run in a transaction block |
| `CREATE DATABASE`, `DROP DATABASE` | Cannot run in a transaction block |
| `ALTER SYSTEM` | Cannot run in a transaction block |
| `ALTER TYPE ... ADD VALUE` | Not allowed in a transaction block on PostgreSQL < 12, and still unusable in the same transaction that adds it |
| `CREATE TABLESPACE`, `DROP TABLESPACE` | Cannot run in a transaction block |

PostgreSQL has transactional DDL, so ordinary `CREATE TABLE`, `ALTER TABLE`,
`CREATE INDEX` (non-concurrent), constraints, triggers, functions and data
backfills are all fine. Every migration currently in `db/migrations/` satisfies
this rule.

**If you genuinely need a non-transactional statement**, do not simply add it —
it will fail at deploy time with
`ERROR: ... cannot run inside a transaction block`, and the fix is a change to
the migrator, not to your file. Options, in order of preference:

1. Avoid it. A non-concurrent `CREATE INDEX` is usually acceptable at this
   table size and is transaction-safe.
2. Apply it as a one-off operational step outside the migrator, recorded in
   `docs/deployment.md`.
3. Change `src/cli/migrate.ts` to run flagged files outside the wrapping
   transaction. If you do this, the advisory lock **must stay transaction-scoped
   or be re-acquired per transaction** — a session-level `pg_advisory_lock`
   orphans itself through the pooler and hangs every subsequent deploy. That
   failure mode is regression-tested in
   `tests/integration/migratePooled.postgres.test.ts`; read it first.

## Other constraints

- **Never edit a migration that has been applied to any deployed environment.**
  The ledger keys on filename, so an edited file will not re-run, and
  environments will silently diverge. Add a new migration instead.
- Migrations 021/022/023 have reviewed content identities recorded in
  `docs/deployment.md`; do not alter them.
- A migration takes lock waits under the run's `lock_timeout` (60s). A migration
  needing to wait longer than that for a table lock will fail the deploy.

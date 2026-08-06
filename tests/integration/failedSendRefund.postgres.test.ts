import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../src/cli/migrate.js';
import { repositoryMigrations, validateDisposableDatabaseUrl } from './support/disposableDatabase.js';
import {
  ambiguousFailure,
  definiteRejection,
  installStubProvider,
  resetStubProvider,
  stubProvider,
  STUB_PROVIDER_NAME
} from './support/stubProvider.js';

/**
 * Issue #151 - return a Letter Pack exactly once when a send terminally fails.
 *
 * A confirmed send deducts the pack BEFORE the provider is called. A
 * pay-per-send order moves to refund_pending on terminal failure, but a prepaid
 * send previously returned nothing at all: the customer paid and got no letter.
 *
 * The invariants here are transactional - exactly-once under replay, per-lot
 * restoration, and the rule that only an explicit provider rejection may
 * compensate - so these run against real PostgreSQL rather than mocks.
 */

const { Pool } = pg;
const enabled = process.env.LIRL_RUN_POSTGRES_INTEGRATION === 'true';
const describePostgres = enabled ? describe : describe.skip;

function schemaName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function databaseUrlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

describePostgres('failed send returns the pack', () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  let ledger: typeof import('../../src/services/creditLedgerService.js');
  let closeServicePool: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const baseUrl = validateDisposableDatabaseUrl(process.env.LIRL_TEST_DATABASE_URL);
    adminPool = new Pool({ connectionString: baseUrl });
    schema = schemaName('lirl_failsend');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scoped = databaseUrlForSchema(baseUrl, schema);
    await migrate({ connectionString: scoped, migrationsDirectory: repositoryMigrations });
    pool = new Pool({ connectionString: scoped, max: 8 });

    process.env.DATABASE_URL = scoped;
    ledger = await import('../../src/services/creditLedgerService.js');
    closeServicePool = (await import('../../src/db/index.js')).closePool;
  }, 180_000);

  afterAll(async () => {
    await closeServicePool?.();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  /**
   * A user who bought credits across TWO lots with different expiries, then
   * spent some on a letter. Two lots on purpose: the return must mirror the
   * original split rather than dumping everything into one fresh lot.
   */
  async function seedSpentLetter(options: {
    lotA: number;
    lotB: number;
    spend: number;
  }): Promise<{ userId: string; letterId: string; expiryA: Date; expiryB: Date }> {
    const userId = `user_${randomUUID()}`;
    const letterId = randomUUID();

    await pool.query(
      `INSERT INTO users (user_id, email, credits, credits_purchased)
       VALUES ($1, $2, $3, $3)`,
      [userId, `${userId}@test.invalid`, options.lotA + options.lotB]
    );

    const lots: { id: string; expiry: Date }[] = [];
    for (const [index, amount] of [options.lotA, options.lotB].entries()) {
      const inserted = await pool.query<{ ledger_id: string; expires_at: Date }>(
        `INSERT INTO credit_ledger (
           user_id, initial_amount, remaining_amount, source_type,
           source_reference_id, activated_at, expires_at, expiration_policy, status
         ) VALUES ($1, $2, $2, 'purchase', $3, NOW(),
                   NOW() + ($4 || ' days')::interval, 'days_from_activation', 'active')
         RETURNING ledger_id, expires_at`,
        [userId, amount, `order_${index}`, String(100 * (index + 1))]
      );
      lots.push({ id: inserted.rows[0].ledger_id, expiry: inserted.rows[0].expires_at });
    }

    await pool.query(
      `INSERT INTO letters (
         letter_id, user_id, content, recipient, credits_cost, status, funding_type
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'queued', 'prepaid_balance')`,
      [
        letterId,
        userId,
        JSON.stringify({ body: 'test' }),
        JSON.stringify({ name: 'R' }),
        options.spend
      ]
    );

    // Spend FIFO across the lots, exactly as deductCreditsFromLedger would, and
    // record the consumption rows the return path reads.
    const txn = await pool.query<{ transaction_id: number }>(
      `INSERT INTO credit_transactions (
         user_id, amount, balance_after, type, reference_type, reference_id, description
       ) VALUES ($1, $2, $3, 'deduction', 'letter', $4, 'send')
       RETURNING transaction_id`,
      [userId, -options.spend, options.lotA + options.lotB - options.spend, letterId]
    );

    let left = options.spend;
    for (const [index, lot] of lots.entries()) {
      const available = index === 0 ? options.lotA : options.lotB;
      const take = Math.min(left, available);
      if (take <= 0) continue;
      await pool.query(
        `UPDATE credit_ledger SET remaining_amount = remaining_amount - $2 WHERE ledger_id = $1`,
        [lot.id, take]
      );
      await pool.query(
        `INSERT INTO credit_consumption (transaction_id, ledger_id, amount, ledger_remaining_after)
         VALUES ($1, $2, $3, $4)`,
        [txn.rows[0].transaction_id, lot.id, take, available - take]
      );
      left -= take;
    }
    await pool.query(
      `UPDATE users SET credits = credits - $2, credits_used = $2 WHERE user_id = $1`,
      [userId, options.spend]
    );

    return { userId, letterId, expiryA: lots[0].expiry, expiryB: lots[1].expiry };
  }

  async function credits(userId: string): Promise<number> {
    const result = await pool.query<{ credits: number }>(
      'SELECT credits FROM users WHERE user_id = $1', [userId]
    );
    return result.rows[0].credits;
  }

  it('returns the consumed credits, split across the original lots', async () => {
    const { userId, letterId, expiryA, expiryB } = await seedSpentLetter({
      lotA: 2, lotB: 5, spend: 5
    });
    expect(await credits(userId)).toBe(2);

    const client = await pool.connect();
    try {
      const returned = await ledger.returnConsumedCreditsForLetter(client, {
        letterId, userId, failureCode: 'provider_definite_rejection'
      });
      expect(returned).toBe(5);
    } finally {
      client.release();
    }

    expect(await credits(userId)).toBe(7);

    // The spend took 2 from lot A and 3 from lot B, so the return must mirror
    // that split - and each returned lot must carry ITS OWN source lot's expiry.
    // Collapsing them into one lot would silently move credits between expiry
    // windows, and they are consumed FIFO by expiry. The takes are deliberately
    // UNEQUAL: with 2 and 2 the amounts and expiries would still line up if the
    // two returned lots had each other's expiry, and the test would prove
    // nothing about the pairing.
    const returnedLots = await pool.query<{
      initial_amount: number; remaining_amount: number; status: string; expires_at: Date;
    }>(
      `SELECT initial_amount, remaining_amount, status, expires_at FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'adjustment'
        ORDER BY expires_at`,
      [userId]
    );
    expect(returnedLots.rows.map(r => r.initial_amount)).toEqual([2, 3]);
    expect(returnedLots.rows[0].expires_at).toEqual(expiryA);
    expect(returnedLots.rows[1].expires_at).toEqual(expiryB);
    // users.credits is a cache; reconcileBalances recomputes it by summing
    // remaining_amount over ACTIVE lots. A returned lot that is inactive or has
    // no remaining balance would restore the customer's balance right up until
    // the next reconciliation quietly took it away again.
    expect(returnedLots.rows.map(r => r.remaining_amount)).toEqual([2, 3]);
    expect(returnedLots.rows.map(r => r.status)).toEqual(['active', 'active']);
  }, 60_000);

  it('returns exactly once however many times failure handling replays', async () => {
    const { userId, letterId } = await seedSpentLetter({ lotA: 10, lotB: 1, spend: 3 });

    for (const _ of [0, 1, 2]) {
      const client = await pool.connect();
      try {
        await ledger.returnConsumedCreditsForLetter(client, {
          letterId, userId, failureCode: 'provider_definite_rejection'
        });
      } finally {
        client.release();
      }
    }

    // 11 bought, 3 spent, 3 returned - once.
    expect(await credits(userId)).toBe(11);
    // One returned lot, not three: the spend came entirely from the
    // earliest-expiring lot (FIFO), so there is a single consumption row to
    // mirror. Three replays must not turn that into three lots.
    const returns = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'adjustment'`,
      [userId]
    );
    expect(returns.rows[0].n).toBe('1');
  }, 60_000);

  it('returns nothing for a letter that never consumed credits', async () => {
    const userId = `user_${randomUUID()}`;
    await pool.query(
      `INSERT INTO users (user_id, email, credits) VALUES ($1, $2, 5)`,
      [userId, `${userId}@test.invalid`]
    );

    const client = await pool.connect();
    try {
      const returned = await ledger.returnConsumedCreditsForLetter(client, {
        letterId: randomUUID(), userId, failureCode: 'provider_definite_rejection'
      });
      expect(returned).toBe(0);
    } finally {
      client.release();
    }
    expect(await credits(userId)).toBe(5);
  }, 60_000);

  it('writes a credit_transactions entry whose balance_after matches the new balance', async () => {
    const { userId, letterId } = await seedSpentLetter({ lotA: 6, lotB: 0 + 1, spend: 2 });

    const client = await pool.connect();
    try {
      await ledger.returnConsumedCreditsForLetter(client, {
        letterId, userId, failureCode: 'provider_definite_rejection'
      });
    } finally {
      client.release();
    }

    // The deduction wrote a debit; without the matching credit the transaction
    // ledger never balances and every later balance_after is wrong.
    const txn = await pool.query<{ amount: number; balance_after: number }>(
      `SELECT amount, balance_after FROM credit_transactions
        WHERE user_id = $1 AND type = 'refund' ORDER BY transaction_id DESC LIMIT 1`,
      [userId]
    );
    expect(txn.rows[0].amount).toBe(2);
    // A literal, not `await credits(userId)`: comparing the ledger against the
    // balance it is supposed to describe passes even if neither was updated.
    expect(txn.rows[0].balance_after).toBe(7);
    expect(await credits(userId)).toBe(7);
  }, 60_000);

  /**
   * End-to-end through the real outbox. The tests above prove the money logic;
   * these prove the terminal paths actually reach it, which reading the two call
   * sites cannot establish.
   */
  // Worth knowing when reading these: they were skipped and red for a while
  // because PostgreSQL rejected the terminal UPDATE outright - one parameter was
  // bound both to a VARCHAR column and to a text comparison - so every definite
  // rejection was caught upstream and held as ambiguous instead. Two lessons
  // stuck: a mocked database would have proved nothing here, and an assertion
  // that "the pack was not returned" passes just as happily when the code never
  // ran at all. Each test below has been checked by mutation for that reason.
  describe('through the real outbox', () => {
    let jobs: typeof import('../../src/services/letterJobService.js');

    beforeAll(async () => {
      await installStubProvider();
      // Migration 015 seeds provider_routing with postgrid for every mail type,
      // and routing consults that table BEFORE falling back to LETTER_PROVIDER.
      // Without this the outbox would reach the real PostGrid client, throw for
      // want of an API key, and classify every outcome as ambiguous - which
      // would make the ambiguous test below pass for entirely the wrong reason.
      await pool.query(
        `UPDATE provider_routing SET provider = $1, enabled = true`,
        [STUB_PROVIDER_NAME]
      );
      jobs = await import('../../src/services/letterJobService.js');
    });

    async function queueJob(letterId: string, maxAttempts = 3): Promise<string> {
      const jobId = randomUUID();
      await pool.query(
        `INSERT INTO letter_jobs (
           job_id, letter_id, status, attempts, max_attempts,
           scheduled_at, idempotency_key, next_attempt_at
         ) VALUES ($1, $2, 'pending', 0, $3, NOW(), $2, NOW())`,
        [jobId, letterId, maxAttempts]
      );
      return jobId;
    }

    async function adjustmentLots(userId: string): Promise<number> {
      const result = await pool.query(
        `SELECT 1 FROM credit_ledger WHERE user_id = $1 AND source_type = 'adjustment'`,
        [userId]
      );
      return result.rowCount ?? 0;
    }

    it('returns the pack when the provider definitively rejects the piece', async () => {
      resetStubProvider();
      const { userId, letterId } = await seedSpentLetter({ lotA: 5, lotB: 1, spend: 2 });
      const jobId = await queueJob(letterId);
      expect(await credits(userId)).toBe(4);

      stubProvider.nextResult = definiteRejection('stub refused');
      await jobs.processLetterJob(jobId);

      // The provider proved no mail exists, so the customer must get the pack
      // back. Before this change the prepaid branch did not exist at all.
      expect(await credits(userId)).toBe(6);
      const job = await pool.query<{ status: string }>(
        'SELECT status FROM letter_jobs WHERE job_id = $1', [jobId]
      );
      expect(job.rows[0].status).toBe('failed');
    }, 60_000);

    it('does NOT return the pack when the outcome is ambiguous', async () => {
      resetStubProvider();
      const { userId, letterId } = await seedSpentLetter({ lotA: 5, lotB: 1, spend: 2 });
      const jobId = await queueJob(letterId);

      stubProvider.nextResult = ambiguousFailure('stub timeout');
      await jobs.processLetterJob(jobId);

      // Premise first. Every assertion below is a negative, and a negative is
      // equally satisfied by a job that was never claimed, a routing regression
      // that never reached this stub, or a pre-dispatch failure - none of which
      // exercise ambiguity handling at all.
      expect(stubProvider.calls.length).toBe(1);
      const held = await pool.query<{ status: string; provider_outcome: string }>(
        'SELECT status, provider_outcome FROM letter_jobs WHERE job_id = $1', [jobId]
      );
      expect(held.rows[0].status).toBe('held');
      expect(held.rows[0].provider_outcome).toBe('ambiguous');

      // The piece may have been printed and posted. Returning the pack here
      // would be paying twice for mail that physically exists, which is why the
      // outbox holds ambiguous outcomes for reconciliation instead.
      expect(await credits(userId)).toBe(4);
      const returns = await pool.query(
        `SELECT 1 FROM credit_ledger WHERE user_id = $1 AND source_type = 'adjustment'`,
        [userId]
      );
      expect(returns.rowCount).toBe(0);
    }, 60_000);

    /**
     * Once the pack is back, the letter must not be resent.
     *
     * Nothing re-deducts on the way back through the outbox, so a retry after a
     * return hands the customer the pack AND the letter. The pay-per-send path
     * has always refused a retry once the money went back; this is the prepaid
     * equivalent, and it only became necessary when the prepaid return started
     * working at all.
     *
     * The exactly-once property itself is proved by the concurrent-resolution
     * test below, which drives two terminal handlers over one letter. Re-running
     * maintenance cannot prove it: a terminally failed job is excluded by the
     * claim predicate, so the calls do nothing and the assertion would hold even
     * with the exactly-once guard deleted. Verified by mutation.
     */
    it('refuses an operator retry once the pack has been returned', async () => {
      resetStubProvider();
      const { userId, letterId } = await seedSpentLetter({ lotA: 5, lotB: 1, spend: 2 });
      const jobId = await queueJob(letterId);

      stubProvider.defaultResult = definiteRejection('stub refused');
      await jobs.processLetterJob(jobId);
      expect(await credits(userId)).toBe(6);

      // A plain re-run must not re-dispatch a terminally failed job at all.
      await jobs.processLetterJob(jobId);
      await jobs.processDueLetterJobs(10);
      expect(stubProvider.calls.length).toBe(1);
      expect(await credits(userId)).toBe(6);

      await expect(jobs.retryLetterJobAsAdmin({
        jobId,
        expectedUserId: userId,
        actorId: 'operator_test',
        reason: 'confirmed rejection, resending',
        idempotencyKey: `retry-${jobId}`
      })).rejects.toMatchObject({ code: 'invalid_state' });

      // Refused, and refused without side effects: the job stays terminal, the
      // pack stays returned exactly once, and nothing was sent.
      const job = await pool.query<{ status: string; provider_outcome: string }>(
        'SELECT status, provider_outcome FROM letter_jobs WHERE job_id = $1', [jobId]
      );
      expect(job.rows[0].status).toBe('failed');
      expect(job.rows[0].provider_outcome).toBe('definite_failure');
      expect(stubProvider.calls.length).toBe(1);
      expect(await credits(userId)).toBe(6);
      expect(await adjustmentLots(userId)).toBe(1);
    }, 60_000);

    /**
     * Attempts exhausted BEFORE the provider was reached.
     *
     * The claim succeeds and then the pre-dispatch guard refuses the piece - the
     * shape of a letter cancelled or held between claim and dispatch. The job
     * never leaves provider_outcome='not_dispatched', so no mail can exist and
     * the pack must come back on the last attempt.
     */
    it('returns the pack when attempts are exhausted before dispatch', async () => {
      resetStubProvider();
      const { userId, letterId } = await seedSpentLetter({ lotA: 5, lotB: 1, spend: 2 });
      const jobId = await queueJob(letterId, 1);
      // Not dispatchable: markProviderDispatch accepts only queued/processing.
      await pool.query(`UPDATE letters SET status = 'draft' WHERE letter_id = $1`, [letterId]);

      await jobs.processLetterJob(jobId);

      // The premise: this failed before the provider, not at it. Without this
      // the test would still pass if the piece had actually been submitted.
      expect(stubProvider.calls.length).toBe(0);
      const job = await pool.query<{ status: string; provider_outcome: string }>(
        'SELECT status, provider_outcome FROM letter_jobs WHERE job_id = $1', [jobId]
      );
      expect(job.rows[0].status).toBe('failed');
      expect(job.rows[0].provider_outcome).toBe('not_dispatched');
      expect(await credits(userId)).toBe(6);
    }, 60_000);

    /**
     * Crash boundary: the process died after dispatching to the provider.
     *
     * The piece may well have been printed and posted - the crash destroyed the
     * only record of what the provider said. Maintenance must quarantine it for
     * reconciliation and must NOT return the pack, because a refund here is a
     * letter given away free.
     */
    it('holds a job that crashed after dispatch, and returns nothing', async () => {
      resetStubProvider();
      const { userId, letterId } = await seedSpentLetter({ lotA: 5, lotB: 1, spend: 2 });
      const jobId = randomUUID();
      // The durable trace of a process that died between provider_dispatch and
      // recording the outcome: claimed, marked dispatching, then the lock aged out.
      await pool.query(
        `INSERT INTO letter_jobs (
           job_id, letter_id, status, attempts, max_attempts, scheduled_at,
           idempotency_key, next_attempt_at, provider_outcome,
           provider_dispatch_started_at, locked_at
         ) VALUES ($1, $2, 'processing', 1, 3, NOW(), $2, NOW(), 'dispatching',
                   NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes')`,
        [jobId, letterId]
      );
      await pool.query(`UPDATE letters SET status = 'processing' WHERE letter_id = $1`, [letterId]);

      await jobs.processDueLetterJobs(10);

      const job = await pool.query<{ status: string; provider_outcome: string }>(
        'SELECT status, provider_outcome FROM letter_jobs WHERE job_id = $1', [jobId]
      );
      expect(job.rows[0].status).toBe('held');
      expect(job.rows[0].provider_outcome).toBe('ambiguous');
      // Never resubmitted: an ambiguous piece must not be mailed a second time.
      expect(stubProvider.calls.length).toBe(0);
      expect(await credits(userId)).toBe(4);
      expect(await adjustmentLots(userId)).toBe(0);
    }, 60_000);

    /**
     * Manual reconciliation. An operator with conclusive evidence closes out an
     * ambiguous hold, and a prepaid customer must be treated exactly as the
     * automatic path treats them: confirmed rejection returns the pack,
     * confirmed acceptance does not.
     */
    it('returns the pack when an operator confirms the piece was rejected', async () => {
      resetStubProvider();
      const { userId, letterId } = await seedSpentLetter({ lotA: 5, lotB: 1, spend: 2 });
      const jobId = await queueJob(letterId);

      stubProvider.nextResult = ambiguousFailure('stub timeout');
      await jobs.processLetterJob(jobId);
      // Held, and deliberately not refunded yet - that is the state an operator
      // is asked to resolve.
      expect(await credits(userId)).toBe(4);
      expect(await adjustmentLots(userId)).toBe(0);

      await jobs.resolveAmbiguousLetterJobAsAdmin({
        jobId,
        expectedUserId: userId,
        actorId: 'operator_test',
        idempotencyKey: `resolve-${jobId}`,
        decision: 'rejected',
        resolution: 'provider_confirmed_rejected_refund',
        providerName: 'dummy'
      });

      expect(await credits(userId)).toBe(6);
      expect(await adjustmentLots(userId)).toBe(1);
    }, 60_000);

    it('returns nothing when an operator confirms the piece was accepted', async () => {
      resetStubProvider();
      const { userId, letterId } = await seedSpentLetter({ lotA: 5, lotB: 1, spend: 2 });
      const jobId = await queueJob(letterId);

      stubProvider.nextResult = ambiguousFailure('stub timeout');
      await jobs.processLetterJob(jobId);

      await jobs.resolveAmbiguousLetterJobAsAdmin({
        jobId,
        expectedUserId: userId,
        actorId: 'operator_test',
        idempotencyKey: `resolve-accepted-${jobId}`,
        decision: 'accepted',
        resolution: 'provider_confirmed_accepted',
        providerName: 'dummy',
        providerTrackingId: 'stub-tracking-1'
      });

      // The mail exists. Refunding it would give the letter away.
      expect(await credits(userId)).toBe(4);
      expect(await adjustmentLots(userId)).toBe(0);
      const letter = await pool.query<{ status: string }>(
        'SELECT status FROM letters WHERE letter_id = $1', [letterId]
      );
      expect(letter.rows[0].status).toBe('accepted');
    }, 60_000);

    /**
     * Two handlers reaching a terminal transition for the same letter at once.
     *
     * The interleaving is the dangerous one and it is real: a dispatch runs long
     * enough for its lock to age out, maintenance quarantines the job as
     * ambiguous, an operator resolves that hold as a confirmed rejection and the
     * pack goes back - and only THEN does the original dispatch return, carrying
     * an authoritative rejection of its own, and commit its own terminal
     * transition. Two independent terminal handlers, one letter. The customer is
     * owed exactly one pack.
     */
    it('returns one pack when a concurrent operator resolution races the dispatch', async () => {
      resetStubProvider();
      const { userId, letterId } = await seedSpentLetter({ lotA: 5, lotB: 1, spend: 2 });
      const jobId = await queueJob(letterId);

      stubProvider.nextResult = definiteRejection('stub refused');
      stubProvider.onSend = async () => {
        // Age the lock out from under the in-flight dispatch, exactly as a slow
        // provider call does, then let maintenance take it over.
        await pool.query(
          `UPDATE letter_jobs SET locked_at = NOW() - INTERVAL '30 minutes' WHERE job_id = $1`,
          [jobId]
        );
        await jobs.processDueLetterJobs(10);
        await jobs.resolveAmbiguousLetterJobAsAdmin({
          jobId,
          expectedUserId: userId,
          actorId: 'operator_test',
          idempotencyKey: `race-${jobId}`,
          decision: 'rejected',
          resolution: 'provider_confirmed_rejected_refund',
          providerName: 'dummy'
        });
      };

      await jobs.processLetterJob(jobId);

      // The premise: the concurrent handler really did reach a terminal
      // transition and really did return the pack before the dispatch finished.
      // If it had not, this test would be asserting nothing.
      expect(stubProvider.calls.length).toBe(1);
      expect(await credits(userId)).toBe(6);
      expect(await adjustmentLots(userId)).toBe(1);
      const job = await pool.query<{ status: string; provider_outcome: string }>(
        'SELECT status, provider_outcome FROM letter_jobs WHERE job_id = $1', [jobId]
      );
      expect(job.rows[0].status).toBe('failed');
      expect(job.rows[0].provider_outcome).toBe('definite_failure');
    }, 60_000);
  });

  it('records only a stable failure code, never provider text', async () => {
    const { userId, letterId } = await seedSpentLetter({ lotA: 4, lotB: 1, spend: 2 });

    const client = await pool.connect();
    try {
      await ledger.returnConsumedCreditsForLetter(client, {
        letterId, userId, failureCode: 'provider_definite_rejection'
      });
    } finally {
      client.release();
    }

    const meta = await pool.query<{ source_metadata: Record<string, unknown> }>(
      `SELECT source_metadata FROM credit_ledger
        WHERE user_id = $1 AND source_type = 'adjustment' LIMIT 1`,
      [userId]
    );
    const stored = JSON.stringify(meta.rows[0].source_metadata);
    expect(stored).toContain('provider_definite_rejection');
    // This row is durable and operator-visible; provider internals and customer
    // content must never reach it.
    expect(stored).not.toMatch(/PostGrid|http|address|recipient/i);
  }, 60_000);
});

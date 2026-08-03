import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  transaction: vi.fn(),
  sendLetter: vi.fn(),
}));
const { query, clientQuery, sendLetter } = mocks;

vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction,
}));
vi.mock('../../../src/services/providers/index.js', () => ({
  getProviderForMailType: vi.fn(async () => ({
    config: { name: 'postgrid', displayName: 'PostGrid' },
    sendLetter: mocks.sendLetter,
  })),
}));

import {
  processDueLetterJobs,
  processLetterJob,
  resolveAmbiguousLetterJobAsAdmin,
  retryLetterJobAsAdmin,
  submitToProviderOnce,
} from '../../../src/services/letterJobService.js';

const job = {
  job_id: 'job-1',
  letter_id: 'letter-1',
  status: 'processing',
  provider_outcome: 'not_dispatched',
  attempts: 1,
  max_attempts: 5,
  idempotency_key: 'letter-1',
  next_attempt_at: new Date(),
  scheduled_at: new Date(),
  created_at: new Date(),
  updated_at: new Date(),
};

const letter = {
  letter_id: 'letter-1',
  user_id: 'user-1',
  content: {
    bodyText: 'Hello',
    signOff: 'Regards',
    sender: {
      name: 'Sender',
      addressLine1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    },
    layoutType: 'text_only',
  },
  recipient: {
    name: 'Recipient',
    addressLine1: '2 Main St',
    city: 'Dallas',
    state: 'TX',
    postalCode: '75201',
    country: 'US',
  },
  credits_cost: 2,
  status: 'queued',
  mail_type: 'letter',
};

function mockClaims(numberOfClaims = 1) {
  let claims = 0;
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('WITH candidate')) {
      claims += 1;
      return { rows: claims <= numberOfClaims ? [{ ...job }] : [] };
    }
    if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...letter }] };
    return { rows: [] };
  });
}

describe('mail outbox retries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
        callback({ query: clientQuery })
    );
    let providerDispatched = false;
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT jobs.letter_id')) {
        return { rows: [{ letter_id: 'letter-1', funding_order_id: null }] };
      }
      if (sql.includes("SET provider_outcome = 'dispatching'")) providerDispatched = true;
      if (sql.startsWith('SELECT status, funding_order_id FROM letters')) {
        return { rows: [{ status: providerDispatched ? 'processing' : 'queued', funding_order_id: null }] };
      }
      if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...letter }] };
      if (sql.startsWith('SELECT * FROM letter_jobs')) {
        return { rows: [{ ...job, provider_outcome: providerDispatched ? 'dispatching' : 'not_dispatched' }] };
      }
      return { rows: [] };
    });
    sendLetter.mockResolvedValue({
      success: true,
      trackingId: 'provider-1',
      costCents: 100,
    });
  });

  // No outcome may be re-submitted automatically. A repeat is only ever safe
  // when the provider authoritatively refused the piece, and an authoritative
  // refusal is not transient, so a second attempt would just re-earn it.
  it.each([
    ['authoritative rejection', {
      success: false, trackingId: '', error: 'HTTP 400',
      metadata: { statusCode: 400, retryable: false, submissionOutcome: 'definite_rejection' },
    }],
    ['ambiguous 5xx', {
      success: false, trackingId: '', error: 'HTTP 503',
      metadata: { statusCode: 503, retryable: true, submissionOutcome: 'ambiguous' },
    }],
    ['ambiguous rate limit', {
      success: false, trackingId: '', error: 'HTTP 429',
      metadata: { statusCode: 429, retryable: true, submissionOutcome: 'ambiguous' },
    }],
    ['unclassified provider failure', {
      success: false, trackingId: '', error: 'provider said no',
    }],
  ])('submits exactly once for a %s', async (_label, providerResult) => {
    const send = vi.fn().mockResolvedValue(providerResult);
    await expect(submitToProviderOnce(send)).resolves.toMatchObject({ success: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('converts a thrown provider error into a single ambiguous outcome', async () => {
    const throwing = vi
      .fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({ success: true, trackingId: 'provider-1' });

    await expect(submitToProviderOnce(throwing)).resolves.toMatchObject({
      success: false,
      metadata: { retryable: false, submissionOutcome: 'ambiguous' },
    });
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it('passes the stable letter ID as the provider idempotency key', async () => {
    mockClaims();
    const result = await processLetterJob('job-1', {});

    expect(result.completed).toBe(true);
    expect(sendLetter).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'letter-1',
    }));
  });

  it('allows only one concurrent claimant to create a provider order', async () => {
    mockClaims();
    const [first, second] = await Promise.all([
      processLetterJob('job-1', {}),
      processLetterJob('job-1', {}),
    ]);

    expect(sendLetter).toHaveBeenCalledTimes(1);
    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
  });

  it('holds instead of replaying after acceptance persistence crashes', async () => {
    let claims = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH candidate')) {
        claims += 1;
        return { rows: claims <= 2 ? [{ ...job }] : [] };
      }
      if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...letter }] };
      if (sql.includes("SET status = 'pending'")) return { rows: [{ job_id: 'job-1' }] };
      return { rows: [] };
    });
    mocks.transaction
      .mockImplementationOnce(
        async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
          callback({ query: clientQuery })
      )
      .mockRejectedValueOnce(new Error('database connection lost before commit acknowledgement'))
      .mockImplementation(
        async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
          callback({ query: clientQuery })
      );

    const first = await processLetterJob('job-1', {});
    expect(first).toMatchObject({ completed: false, retryScheduled: false });
    expect(sendLetter).toHaveBeenCalledTimes(1);
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      expect.anything()
    );
  });

  it('redacts letter, job, provider, and exception details when recovery scheduling fails', async () => {
    const sensitive = 'private database failure letter-1 job-1 provider-private';
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH candidate')) return { rows: [{ ...job }] };
      if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...letter }] };
      if (sql.includes("SET status = 'pending'")) throw new Error(sensitive);
      return { rows: [] };
    });
    mocks.transaction
      .mockImplementationOnce(
        async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
          callback({ query: clientQuery })
      )
      .mockRejectedValueOnce(new Error(sensitive))
      .mockRejectedValueOnce(new Error(sensitive));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await processLetterJob('job-1', {});

    expect(result).toMatchObject({ completed: false, retryScheduled: false });
    const output = diagnostic.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('"event":"outbox.persistence_recovery_schedule_failed"');
    for (const value of [sensitive, 'letter-1', 'job-1', 'provider-private']) {
      expect(output).not.toContain(value);
    }
    diagnostic.mockRestore();
  });

  it('holds a timed-out send for operator recovery', async () => {
    mockClaims();
    sendLetter.mockResolvedValue({
      success: false,
      trackingId: '',
      error: 'network timeout',
      metadata: { retryable: true },
    });

    const result = await processLetterJob('job-1', {
      random: () => 0,
    });
    expect(result.retryScheduled).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'held'"),
      expect.anything()
    );
  });

  it('does not refund an ambiguous provider timeout when the attempt counter is exhausted', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH candidate')) {
        return { rows: [{ ...job, attempts: 5, max_attempts: 5 }] };
      }
      if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...letter }] };
      return { rows: [] };
    });
    sendLetter.mockResolvedValue({
      success: false,
      trackingId: '',
      error: 'network timeout after submission',
      metadata: { retryable: true },
    });

    const result = await processLetterJob('job-1', {
      random: () => 0,
    });

    expect(result).toMatchObject({ completed: false, retryScheduled: false });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'held'"),
      expect.anything()
    );
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      expect.anything()
    );
  });

  it('moves an explicitly rejected pre-provider submission to refund recovery', async () => {
    mockClaims();
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT jobs.letter_id')) {
        return { rows: [{ letter_id: 'letter-1', funding_order_id: 'order-1' }] };
      }
      if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...letter }] };
      if (sql.startsWith('SELECT * FROM letter_jobs')) return { rows: [{ ...job }] };
      if (sql.includes('SELECT funding_order_id FROM letters')) {
        return { rows: [{ funding_order_id: 'order-1' }] };
      }
      if (sql.includes('SELECT status FROM orders')) {
        return { rows: [{ status: 'fulfillment_pending' }] };
      }
      if (sql.includes('SELECT order_id FROM orders')) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      if (sql.includes('SELECT letter_id FROM letter_jobs')) {
        return { rows: [{ letter_id: 'letter-1' }] };
      }
      if (sql.includes('SELECT order_id FROM orders')) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      if (sql.includes('SELECT letter_id FROM letter_jobs')) {
        return { rows: [{ letter_id: 'letter-1' }] };
      }
      if (sql.includes("SET status = 'refund_pending'")) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      return { rows: [] };
    });
    sendLetter.mockResolvedValue({
      success: false,
      trackingId: '',
      error: 'HTTP 400 invalid address',
      metadata: { retryable: false, submissionOutcome: 'definite_rejection' },
    });

    const result = await processLetterJob('job-1', {});

    expect(result).toMatchObject({ completed: false, retryScheduled: false });
    // The compensation must target the funding order already locked by the
    // canonical order -> letter -> job sequence, never a re-derived letter_id.
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE order_id = $1'),
      ['order-1', 'HTTP 400 invalid address']
    );
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      expect.arrayContaining(['letter-1'])
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("'provider.terminal_failure'"),
      expect.arrayContaining(['order-1'])
    );
  });

  it('never refunds a paid send whose provider outcome is only ambiguous', async () => {
    mockClaims();
    const held: string[] = [];
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT jobs.letter_id')) {
        return { rows: [{ letter_id: 'letter-1', funding_order_id: 'order-1' }] };
      }
      if (sql.startsWith('SELECT * FROM letters')) return { rows: [{ ...letter }] };
      if (sql.startsWith('SELECT * FROM letter_jobs')) return { rows: [{ ...job }] };
      if (sql.includes('SELECT funding_order_id FROM letters')) {
        return { rows: [{ funding_order_id: 'order-1' }] };
      }
      if (sql.includes('SELECT status FROM orders')) {
        return { rows: [{ status: 'fulfillment_pending' }] };
      }
      if (sql.includes('SELECT order_id FROM orders')) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      if (sql.includes('SELECT letter_id FROM letter_jobs')) {
        return { rows: [{ letter_id: 'letter-1' }] };
      }
      if (sql.includes("hold_reason = 'provider_outcome_ambiguous'")) held.push(sql);
      return { rows: [] };
    });
    // An upstream gateway can answer 5xx after the origin already accepted the
    // piece, so exhausting these attempts must hold, never compensate.
    sendLetter.mockResolvedValue({
      success: false,
      trackingId: '',
      error: 'HTTP 503 service unavailable',
      metadata: { statusCode: 503, retryable: true, submissionOutcome: 'ambiguous' },
    });

    const result = await processLetterJob('job-1', {});

    expect(result).toMatchObject({ completed: false, retryScheduled: false });
    expect(sendLetter).toHaveBeenCalledTimes(1);
    expect(held.length).toBeGreaterThan(0);
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      expect.anything()
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("'mail_provider_outcome_ambiguous'"),
      expect.anything()
    );
  });

  it('recovers a due or stale job during a one-shot maintenance batch', async () => {
    mockClaims();
    const result = await processDueLetterJobs(25, {});
    expect(result).toEqual({ processed: 1, completed: 1, retryScheduled: 0, failed: 0 });
    expect(sendLetter).toHaveBeenCalledTimes(1);
  });

  it('replays an exact admin retry but rejects reuse by a different actor or reason', async () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM commerce_operator_audit_events')) {
        return { rows: [{
          operation: 'mail_job_retry',
          target_type: 'letter_job',
          target_reference_hash: hash('job-1'),
          actor_subject_hash: hash('admin-1'),
          operator_reason_hash: hash('provider confirmed rejection'),
          expected_user_hash: hash('user-1')
        }] };
      }
      return { rows: [] };
    });

    await expect(retryLetterJobAsAdmin({
      jobId: 'job-1', expectedUserId: 'user-1', actorId: 'admin-1', reason: 'provider confirmed rejection',
      idempotencyKey: 'retry-job-exact-001'
    })).resolves.toEqual({ jobId: 'job-1', replayed: true });

    await expect(retryLetterJobAsAdmin({
      jobId: 'job-1', expectedUserId: 'user-1', actorId: 'admin-2', reason: 'different operator decision',
      idempotencyKey: 'retry-job-exact-001'
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(retryLetterJobAsAdmin({
      jobId: 'job-1', expectedUserId: 'other-user', actorId: 'admin-1',
      reason: 'provider confirmed rejection', idempotencyKey: 'retry-job-exact-001'
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('records a confirmed ambiguous acceptance without calling the mail provider again', async () => {
    const jobId = '00000000-0000-4000-8000-000000000301';
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM commerce_operator_audit_events')) return { rows: [] };
      if (sql.includes('SELECT jobs.letter_id')) {
        return { rows: [{ letter_id: 'letter-1', funding_order_id: null }] };
      }
      if (sql.startsWith('SELECT user_id, status, funding_order_id FROM letters')) {
        return { rows: [{ user_id: 'user-1', status: 'held', funding_order_id: null }] };
      }
      if (sql.startsWith('SELECT * FROM letter_jobs')) {
        return { rows: [{ ...job, job_id: jobId, status: 'held', provider_outcome: 'ambiguous' }] };
      }
      return { rows: [] };
    });

    await expect(resolveAmbiguousLetterJobAsAdmin({
      jobId,
      expectedUserId: 'user-1',
      actorId: 'admin-1',
      idempotencyKey: 'resolve-mail-accepted-001',
      decision: 'accepted',
      resolution: 'provider_confirmed_accepted',
      providerName: 'postgrid',
      providerTrackingId: 'provider-confirmed-301'
    })).resolves.toMatchObject({
      replayed: false, jobStatus: 'completed', letterStatus: 'accepted'
    });

    expect(sendLetter).not.toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("'mail_fulfillment_resolve'"),
      expect.anything()
    );
  });

  it('rejects an ambiguous mail resolution bound to another account', async () => {
    const jobId = '00000000-0000-4000-8000-000000000302';
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM commerce_operator_audit_events')) return { rows: [] };
      if (sql.includes('SELECT jobs.letter_id')) {
        return { rows: [{ letter_id: 'letter-1', funding_order_id: null }] };
      }
      if (sql.startsWith('SELECT user_id, status, funding_order_id FROM letters')) {
        return { rows: [{ user_id: 'user-1', status: 'held', funding_order_id: null }] };
      }
      if (sql.startsWith('SELECT * FROM letter_jobs')) {
        return { rows: [{ ...job, job_id: jobId, status: 'held', provider_outcome: 'ambiguous' }] };
      }
      return { rows: [] };
    });

    await expect(resolveAmbiguousLetterJobAsAdmin({
      jobId,
      expectedUserId: 'different-user',
      actorId: 'admin-1',
      idempotencyKey: 'resolve-mail-cross-user-001',
      decision: 'rejected',
      resolution: 'provider_confirmed_rejected_refund',
      providerName: 'postgrid'
    })).rejects.toMatchObject({ code: 'not_found' });
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE letter_jobs SET status'),
      expect.anything()
    );
  });
});

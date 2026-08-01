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
  sendWithBoundedRetries,
} from '../../../src/services/letterJobService.js';

const job = {
  job_id: 'job-1',
  letter_id: 'letter-1',
  status: 'processing',
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
    clientQuery.mockResolvedValue({ rows: [] });
    sendLetter.mockResolvedValue({
      success: true,
      trackingId: 'provider-1',
      costCents: 100,
    });
  });

  it.each([429, 503])('retries transient HTTP %s responses with bounded backoff', async (statusCode) => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        trackingId: '',
        error: `HTTP ${statusCode}`,
        metadata: { statusCode, retryable: true },
      })
      .mockResolvedValueOnce({ success: true, trackingId: 'provider-1' });

    const result = await sendWithBoundedRetries(send, {
      sleep: async () => undefined,
      random: () => 0,
    });
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries a network timeout but not a permanent provider rejection', async () => {
    const timeoutSend = vi
      .fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({ success: true, trackingId: 'provider-1' });
    await expect(
      sendWithBoundedRetries(timeoutSend, { sleep: async () => undefined, random: () => 0 })
    ).resolves.toMatchObject({ success: true });

    const rejected = vi.fn().mockResolvedValue({
      success: false,
      trackingId: '',
      error: 'HTTP 400',
      metadata: { retryable: false },
    });
    await sendWithBoundedRetries(rejected, { sleep: async () => undefined });
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('passes the stable letter ID as the provider idempotency key', async () => {
    mockClaims();
    const result = await processLetterJob('job-1', { retryBaseDelayMs: 0 });

    expect(result.completed).toBe(true);
    expect(sendLetter).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'letter-1',
    }));
  });

  it('allows only one concurrent claimant to create a provider order', async () => {
    mockClaims();
    const [first, second] = await Promise.all([
      processLetterJob('job-1', { retryBaseDelayMs: 0 }),
      processLetterJob('job-1', { retryBaseDelayMs: 0 }),
    ]);

    expect(sendLetter).toHaveBeenCalledTimes(1);
    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
  });

  it('replays with the same provider key after acceptance persistence crashes', async () => {
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
      .mockRejectedValueOnce(new Error('database connection lost before commit acknowledgement'))
      .mockImplementation(
        async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
          callback({ query: clientQuery })
      );

    const first = await processLetterJob('job-1', { retryBaseDelayMs: 0 });
    const replay = await processLetterJob('job-1', { retryBaseDelayMs: 0 });

    expect(first).toMatchObject({ completed: false, retryScheduled: true });
    expect(replay).toMatchObject({ completed: true, retryScheduled: false });
    expect(sendLetter).toHaveBeenCalledTimes(2);
    expect(sendLetter.mock.calls.map(([params]) => params.idempotencyKey)).toEqual([
      'letter-1',
      'letter-1',
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE job_id = $1 AND status = 'processing'"),
      expect.arrayContaining(['job-1', expect.stringContaining('reconciliation required')])
    );
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      expect.anything()
    );
  });

  it('reschedules a timed-out send for hourly recovery', async () => {
    mockClaims();
    sendLetter.mockResolvedValue({
      success: false,
      trackingId: '',
      error: 'network timeout',
      metadata: { retryable: true },
    });

    const result = await processLetterJob('job-1', {
      providerRetries: 1,
      retryBaseDelayMs: 0,
      random: () => 0,
    });
    expect(result.retryScheduled).toBe(true);
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = $1"),
      expect.arrayContaining(['pending'])
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
      providerRetries: 1,
      retryBaseDelayMs: 0,
      random: () => 0,
    });

    expect(result).toMatchObject({ completed: false, retryScheduled: true });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('THEN GREATEST(max_attempts - 1, 0)'),
      expect.arrayContaining(['pending'])
    );
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      expect.anything()
    );
  });

  it('moves an explicitly rejected pre-provider submission to refund recovery', async () => {
    mockClaims();
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SET status = 'refund_pending'")) {
        return { rows: [{ order_id: 'order-1' }] };
      }
      return { rows: [] };
    });
    sendLetter.mockResolvedValue({
      success: false,
      trackingId: '',
      error: 'HTTP 400 invalid address',
      metadata: { retryable: false },
    });

    const result = await processLetterJob('job-1', { providerRetries: 1 });

    expect(result).toMatchObject({ completed: false, retryScheduled: false });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'refund_pending'"),
      ['letter-1', 'HTTP 400 invalid address']
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("'provider.terminal_failure'"),
      expect.arrayContaining(['order-1'])
    );
  });

  it('recovers a due or stale job during a one-shot maintenance batch', async () => {
    mockClaims();
    const result = await processDueLetterJobs(25, { retryBaseDelayMs: 0 });
    expect(result).toEqual({ processed: 1, completed: 1, retryScheduled: 0, failed: 0 });
    expect(sendLetter).toHaveBeenCalledTimes(1);
  });
});

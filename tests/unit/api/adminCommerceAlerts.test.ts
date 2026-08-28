import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  query: vi.fn(),
  transaction: vi.fn(),
  clientQuery: vi.fn()
}));

const mailService = vi.hoisted(() => {
  class AdminJobRetryError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  class AdminMailResolutionError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  return {
    AdminJobRetryError,
    AdminMailResolutionError,
    getAllJobs: vi.fn(),
    getJobById: vi.fn(),
    getJobsByUserId: vi.fn(),
    resolveAmbiguousLetterJobAsAdmin: vi.fn(),
    retryLetterJobAsAdmin: vi.fn()
  };
});

vi.mock('../../../src/api/middleware/adminAuth.js', () => ({
  authenticateAdmin: mocks.authenticateAdmin,
  validateAdminRequestBoundary: vi.fn(() => true)
}));
vi.mock('../../../src/db/index.js', () => ({
  query: mocks.query,
  transaction: mocks.transaction
}));
vi.mock('../../../src/services/letterJobService.js', () => mailService);

import { handleAdminApiRequest } from '../../../src/api/adminApiHandler.js';

const alertId = '00000000-0000-4000-8000-000000000201';

function response() {
  return { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
}

function mutation(body: Record<string, unknown>) {
  const pathname = `/api/admin/commerce-alerts/${alertId}`;
  const req = Object.assign(new EventEmitter(), {
    method: 'PATCH',
    url: pathname,
    headers: { host: 'localhost' }
  });
  const res = response();
  const handled = handleAdminApiRequest(req as never, res as never, pathname);
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return { handled, res };
}

describe('commerce operational alert admin surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateAdmin.mockResolvedValue({ userId: 'auth0|operator-1' });
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM commerce_operational_alerts') ? [{
        alert_id: alertId,
        order_id: 'order-operator-visible',
        alert_type: 'mail_provider_outcome_ambiguous',
        severity: 'critical',
        status: 'open',
        details: { providerOutcome: 'ambiguous' },
        created_at: new Date('2026-08-01T00:00:00.000Z')
      }] : []
    }));
    mocks.transaction.mockImplementation(async callback => callback({ query: mocks.clientQuery }));
  });

  it('requires admin authentication before ambiguous mail can be resolved', async () => {
    mocks.authenticateAdmin.mockResolvedValue(null);
    const pathname = `/api/admin/jobs/00000000-0000-4000-8000-000000000301/resolve-ambiguous`;
    const req = { method: 'POST', url: pathname, headers: { host: 'localhost' } };

    await expect(handleAdminApiRequest(
      req as never, response() as never, pathname
    )).resolves.toBe(true);
    expect(mailService.resolveAmbiguousLetterJobAsAdmin).not.toHaveBeenCalled();
  });

  it('binds ambiguous mail acceptance to the authenticated actor and expected account', async () => {
    const jobId = '00000000-0000-4000-8000-000000000301';
    mailService.resolveAmbiguousLetterJobAsAdmin.mockResolvedValue({
      jobId,
      decision: 'accepted',
      resolution: 'provider_confirmed_accepted',
      jobStatus: 'completed',
      letterStatus: 'accepted',
      orderStatus: 'fulfilled',
      replayed: false
    });
    const pathname = `/api/admin/jobs/${jobId}/resolve-ambiguous`;
    const req = Object.assign(new EventEmitter(), {
      method: 'POST', url: pathname, headers: { host: 'localhost' }
    });
    const res = response();
    const handled = handleAdminApiRequest(req as never, res as never, pathname);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify({
        userId: 'auth0|mail-owner',
        actorId: 'untrusted-body-actor',
        idempotencyKey: 'resolve-mail-api-001',
        decision: 'accepted',
        resolution: 'provider_confirmed_accepted',
        providerName: 'postgrid',
        providerTrackingId: 'provider-reference-301'
      })));
      req.emit('end');
    });

    await handled;

    expect(mailService.resolveAmbiguousLetterJobAsAdmin).toHaveBeenCalledWith({
      jobId,
      expectedUserId: 'auth0|mail-owner',
      actorId: 'auth0|operator-1',
      idempotencyKey: 'resolve-mail-api-001',
      decision: 'accepted',
      resolution: 'provider_confirmed_accepted',
      providerName: 'postgrid',
      providerTrackingId: 'provider-reference-301'
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts only the explicit provider-confirmed retry pair for held mail', async () => {
    const jobId = '00000000-0000-4000-8000-000000000302';
    mailService.resolveAmbiguousLetterJobAsAdmin.mockResolvedValue({
      jobId,
      decision: 'retry',
      resolution: 'provider_confirmed_rejected_retry',
      jobStatus: 'pending',
      letterStatus: 'queued',
      orderStatus: 'fulfillment_pending',
      replayed: false
    });
    const pathname = `/api/admin/jobs/${jobId}/resolve-ambiguous`;
    const req = Object.assign(new EventEmitter(), {
      method: 'POST', url: pathname, headers: { host: 'localhost' }
    });
    const res = response();
    const handled = handleAdminApiRequest(req as never, res as never, pathname);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify({
        userId: 'auth0|mail-owner',
        idempotencyKey: 'resolve-mail-api-002',
        decision: 'retry',
        resolution: 'provider_confirmed_rejected_retry',
        providerName: 'postgrid'
      })));
      req.emit('end');
    });

    await handled;

    expect(mailService.resolveAmbiguousLetterJobAsAdmin).toHaveBeenCalledWith({
      jobId,
      expectedUserId: 'auth0|mail-owner',
      actorId: 'auth0|operator-1',
      idempotencyKey: 'resolve-mail-api-002',
      decision: 'retry',
      resolution: 'provider_confirmed_rejected_retry',
      providerName: 'postgrid',
      providerTrackingId: undefined
    });
    expect(res.statusCode).toBe(200);
  });

  it('surfaces durable commerce alerts in the authenticated alert feed', async () => {
    const req = { method: 'GET', url: '/api/admin/alerts', headers: { host: 'localhost' } };
    const res = response();

    await handleAdminApiRequest(req as never, res as never, '/api/admin/alerts');

    const body = JSON.parse(String(res.end.mock.calls[0][0]));
    expect(body.alerts).toContainEqual(expect.objectContaining({
      type: 'commerce_operations', severity: 'critical',
      data: [expect.objectContaining({ alert_id: alertId, status: 'open' })]
    }));
  });

  it('commits an operator-attributed resolution and append-only audit together', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM commerce_operator_audit_events')) return { rows: [] };
      if (sql.includes('FROM commerce_operational_alerts')) {
        return { rows: [{ status: 'open', severity: 'critical', alert_type: 'stripe_dispute_created' }] };
      }
      return { rows: [] };
    });
    const { handled, res } = mutation({
      status: 'resolved', resolutionCode: 'provider_review_complete',
      idempotencyKey: 'commerce-alert-resolution-001'
    });

    await handled;

    expect(res.statusCode).toBe(200);
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO commerce_operator_audit_events'),
      expect.arrayContaining([
        createHash('sha256').update('auth0|operator-1').digest('hex'),
        createHash('sha256').update(alertId).digest('hex')
      ])
    );
  });

  it('replays only an exact alert decision and rejects cross-actor key reuse', async () => {
    const exactAudit = {
      operation: 'commerce_alert_transition',
      target_type: 'commerce_alert',
      target_reference_hash: createHash('sha256').update(alertId).digest('hex'),
      actor_subject_hash: createHash('sha256').update('auth0|operator-1').digest('hex'),
      reason_code: 'operator_acknowledged',
      requested_status: 'acknowledged'
    };
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM commerce_operator_audit_events') ? [exactAudit] : []
    }));
    const first = mutation({
      status: 'acknowledged', idempotencyKey: 'commerce-alert-ack-001'
    });
    await first.handled;
    expect(JSON.parse(String(first.res.end.mock.calls[0][0]))).toMatchObject({ replayed: true });

    mocks.authenticateAdmin.mockResolvedValue({ userId: 'auth0|operator-2' });
    const conflict = mutation({
      status: 'acknowledged', idempotencyKey: 'commerce-alert-ack-001'
    });
    await conflict.handled;
    expect(conflict.res.statusCode).toBe(409);
    expect(JSON.parse(String(conflict.res.end.mock.calls[0][0]))).toEqual({
      error: 'idempotency_conflict'
    });
  });
});

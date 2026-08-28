import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const adminAuth = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  validateAdminRequestBoundary: vi.fn(() => true)
}));

const imageService = vi.hoisted(() => {
  class ImageGenerationResolutionError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'ImageGenerationResolutionError';
    }
  }
  return {
    getGenerationQuota: vi.fn(),
    listAmbiguousGenerationReservations: vi.fn(),
    resolveAmbiguousGenerationReservation: vi.fn(),
    ImageGenerationResolutionError
  };
});

vi.mock('../../../src/api/middleware/adminAuth.js', () => adminAuth);
vi.mock('../../../src/services/imageGenerationLimitService.js', () => imageService);
vi.mock('../../../src/db/index.js', () => ({ query: vi.fn(), transaction: vi.fn() }));

import { handleAdminApiRequest } from '../../../src/api/adminApiHandler.js';

const reservationId = '00000000-0000-4000-8000-000000000001';
const userId = 'auth0|private-image-user';
const providerRequestId = 'provider-private-image-id';

function response() {
  return { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
}

describe('ambiguous image-generation admin recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminAuth.authenticateAdmin.mockResolvedValue({ userId: 'auth0|admin-operator' });
  });

  afterEach(() => vi.restoreAllMocks());

  it('requires the existing admin authentication boundary before inspection', async () => {
    adminAuth.authenticateAdmin.mockResolvedValue(null);
    const req = {
      method: 'GET',
      url: '/api/admin/image-generation/ambiguous',
      headers: { host: 'localhost' }
    };
    const res = response();

    await expect(handleAdminApiRequest(
      req as never,
      res as never,
      '/api/admin/image-generation/ambiguous'
    )).resolves.toBe(true);
    expect(imageService.listAmbiguousGenerationReservations).not.toHaveBeenCalled();
  });

  it('returns inspectable evidence without logging account or provider identifiers', async () => {
    imageService.listAmbiguousGenerationReservations.mockResolvedValue([{
      reservationId,
      userId,
      providerRequestId,
      resolutionReason: 'provider_outcome_unknown',
      dispatchStartedAt: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:30:00.000Z')
    }]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const req = {
      method: 'GET',
      url: '/api/admin/image-generation/ambiguous?limit=25',
      headers: { host: 'localhost' }
    };
    const res = response();

    await handleAdminApiRequest(
      req as never,
      res as never,
      '/api/admin/image-generation/ambiguous'
    );

    expect(imageService.listAmbiguousGenerationReservations).toHaveBeenCalledWith(25);
    expect(JSON.parse(String(res.end.mock.calls[0][0])).reservations[0]).toMatchObject({
      reservationId,
      userId,
      providerRequestId
    });
    const logged = log.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('"event":"admin.image_resolution_inspection_completed"');
    expect(logged).toContain('"resultCount":1');
    expect(logged).not.toContain(reservationId);
    expect(logged).not.toContain(userId);
    expect(logged).not.toContain(providerRequestId);
  });

  it('binds a consume decision to the authenticated actor and expected account', async () => {
    imageService.resolveAmbiguousGenerationReservation.mockResolvedValue({
      reservationId,
      userId,
      decision: 'consume',
      resolution: 'provider_confirmed_succeeded',
      resultingStatus: 'consumed',
      replayed: false
    });
    const pathname = `/api/admin/image-generation/ambiguous/${reservationId}/resolve`;
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: pathname,
      headers: { host: 'localhost' }
    });
    const res = response();
    const handled = handleAdminApiRequest(req as never, res as never, pathname);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify({
        userId,
        actorId: 'untrusted-body-actor',
        idempotencyKey: 'image-resolution-consume-001',
        decision: 'consume',
        resolution: 'provider_confirmed_succeeded'
      })));
      req.emit('end');
    });
    await handled;

    expect(imageService.resolveAmbiguousGenerationReservation).toHaveBeenCalledWith({
      reservationId,
      expectedUserId: userId,
      actorId: 'auth0|admin-operator',
      idempotencyKey: 'image-resolution-consume-001',
      decision: 'consume',
      resolution: 'provider_confirmed_succeeded'
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns an idempotent replay as success without inventing another operation', async () => {
    imageService.resolveAmbiguousGenerationReservation.mockResolvedValue({
      reservationId,
      userId,
      decision: 'release',
      resolution: 'provider_confirmed_failed',
      resultingStatus: 'released',
      replayed: true
    });
    const pathname = `/api/admin/image-generation/ambiguous/${reservationId}/resolve`;
    const res = response();
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: pathname,
      headers: { host: 'localhost' }
    });
    const handled = handleAdminApiRequest(req as never, res as never, pathname);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify({
        userId,
        idempotencyKey: 'image-resolution-release-001',
        decision: 'release',
        resolution: 'provider_confirmed_failed'
      })));
      req.emit('end');
    });
    await handled;

    expect(JSON.parse(String(res.end.mock.calls[0][0]))).toMatchObject({ replayed: true });
    expect(res.statusCode).toBe(200);
  });

  it('fails closed for a cross-user reservation binding without leaking identifiers', async () => {
    imageService.resolveAmbiguousGenerationReservation.mockRejectedValue(
      new imageService.ImageGenerationResolutionError('not_found')
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pathname = `/api/admin/image-generation/ambiguous/${reservationId}/resolve`;
    const res = response();
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: pathname,
      headers: { host: 'localhost' }
    });
    const handled = handleAdminApiRequest(req as never, res as never, pathname);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify({
        userId: 'auth0|wrong-user',
        idempotencyKey: 'image-resolution-cross-user',
        decision: 'release',
        resolution: 'provider_confirmed_failed'
      })));
      req.emit('end');
    });
    await handled;

    expect(res.statusCode).toBe(404);
    const logged = warn.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('"errorClass":"not_found"');
    expect(logged).not.toContain(reservationId);
    expect(logged).not.toContain(userId);
    expect(logged).not.toContain(providerRequestId);
  });

  it('rejects an arbitrary consume/failure combination before service mutation', async () => {
    const pathname = `/api/admin/image-generation/ambiguous/${reservationId}/resolve`;
    const res = response();
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: pathname,
      headers: { host: 'localhost' }
    });
    const handled = handleAdminApiRequest(req as never, res as never, pathname);
    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify({
        userId,
        idempotencyKey: 'image-resolution-invalid-001',
        decision: 'consume',
        resolution: 'provider_confirmed_failed'
      })));
      req.emit('end');
    });
    await handled;

    expect(res.statusCode).toBe(400);
    expect(imageService.resolveAmbiguousGenerationReservation).not.toHaveBeenCalled();
  });
});

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logRestRequestOnFinish } from '../../../src/api/restRequestLog.js';

/**
 * The REST request log line carries the route's table id, the method and the
 * status, and nothing else. Paths carry letter ids, promo codes and token ids,
 * so a line built from the path would put them in the log.
 */

function finish(method: string, path: string, status: number): Record<string, unknown>[] {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const res = Object.assign(new EventEmitter(), { statusCode: status });
  logRestRequestOnFinish({ method } as never, res as never, path);
  res.emit('finish');
  return log.mock.calls.map(call => JSON.parse(String(call[0])));
}

describe('the REST request log line', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the route by its table id and carries nothing else', () => {
    const lines = finish('GET', '/api/letters/ltr_private123', 200);

    // Exact equality: an added field fails this, not only a changed one.
    expect(lines).toEqual([
      { route: 'letters.get', method: 'GET', status: 200, event: 'rest.request', msg: 'rest.request' }
    ]);
    expect(JSON.stringify(lines)).not.toContain('ltr_private123');
  });

  it('keeps a promo code out of the log', () => {
    const lines = finish('GET', '/api/promo/validate/PRIVATECODE', 403);

    expect(lines[0].route).toBe('promo.validate');
    expect(JSON.stringify(lines)).not.toContain('PRIVATECODE');
  });

  it('logs a path no route matches as unmatched, not as itself', () => {
    const lines = finish('DELETE', '/api/tokens/not-a-number', 404);

    expect(lines[0].route).toBe('unmatched');
    expect(JSON.stringify(lines)).not.toContain('not-a-number');
  });

  it('writes nothing until the response finishes', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });

    logRestRequestOnFinish({ method: 'GET' } as never, res as never, '/api/letters');

    expect(log).not.toHaveBeenCalled();
  });

  it('reads the status when the response finishes, not when the listener is attached', () => {
    // httpServer.ts attaches the listener before any handler has set a status,
    // so a status read at attach time would log every refusal as 200.
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });

    logRestRequestOnFinish({ method: 'GET' } as never, res as never, '/api/letters');
    res.statusCode = 403;
    res.emit('finish');

    expect(JSON.parse(String(log.mock.calls[0][0])).status).toBe(403);
  });
});

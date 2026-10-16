import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maintenanceHeartbeatUrl,
  maintenanceHeartbeatUrlInvalid,
  sendMaintenanceHeartbeat
} from '../../../src/services/maintenanceHeartbeat.js';

/**
 * The maintenance cron's dead man's switch (#408): after a run finishes it
 * calls a monitor's URL, and the monitor alerts when the calls stop.
 */

const PING = 'https://hc-ping.com/5b7c1b8e-0000-4000-8000-000000000001';

function capture(): () => string {
  const spies = (['log', 'info', 'warn', 'error'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation(() => undefined)
  );
  return () => spies.flatMap(spy => spy.mock.calls.flat().map(String)).join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the maintenance heartbeat URL', () => {
  it('reads an https URL, trimmed', () => {
    expect(maintenanceHeartbeatUrl({ MAINTENANCE_HEARTBEAT_URL: `  ${PING} ` })).toBe(PING);
    expect(maintenanceHeartbeatUrlInvalid({ MAINTENANCE_HEARTBEAT_URL: PING })).toBe(false);
  });

  it('is off when unset or blank, and invalid when it is not https', () => {
    for (const env of [{}, { MAINTENANCE_HEARTBEAT_URL: '' }, { MAINTENANCE_HEARTBEAT_URL: '  ' }]) {
      expect(maintenanceHeartbeatUrl(env)).toBeNull();
      expect(maintenanceHeartbeatUrlInvalid(env)).toBe(false);
    }
    for (const value of ['http://hc-ping.com/x', 'hc-ping.com/x', 'not a url', 'https://user:pass@hc-ping.com/x']) {
      expect(maintenanceHeartbeatUrl({ MAINTENANCE_HEARTBEAT_URL: value }), value).toBeNull();
      expect(maintenanceHeartbeatUrlInvalid({ MAINTENANCE_HEARTBEAT_URL: value }), value).toBe(true);
    }
  });
});

describe('sending the heartbeat', () => {
  it('calls the URL once with GET, under a deadline, and reports it sent', async () => {
    const fetchImpl = vi.fn(async () => new Response('OK', { status: 200 }));
    await expect(sendMaintenanceHeartbeat({ MAINTENANCE_HEARTBEAT_URL: PING }, fetchImpl)).resolves.toBe('sent');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(PING);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives up on a monitor that does not answer, rather than holding up the run', async () => {
    const hung = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const output = capture();
    await expect(sendMaintenanceHeartbeat({ MAINTENANCE_HEARTBEAT_URL: PING }, hung as never, 20)).resolves.toBe('failed');
    expect(output()).toContain('"errorClass":"ETIMEDOUT"');
  });

  it('says so, on every run, when the URL is set but unusable', async () => {
    const output = capture();
    const fetchImpl = vi.fn();
    await expect(
      sendMaintenanceHeartbeat({ MAINTENANCE_HEARTBEAT_URL: 'http://hc-ping.com/abc' }, fetchImpl)
    ).resolves.toBe('invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output()).toContain('maintenance.heartbeat_url_invalid');
    expect(output()).not.toContain('hc-ping.com');
  });

  it('does nothing when no URL is set', async () => {
    const fetchImpl = vi.fn();
    await expect(sendMaintenanceHeartbeat({}, fetchImpl)).resolves.toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a refused or failed call without throwing, and never logs the URL', async () => {
    const output = capture();
    const refused = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(sendMaintenanceHeartbeat({ MAINTENANCE_HEARTBEAT_URL: PING }, refused)).resolves.toBe('failed');
    // As undici fails: the host and the code sit on the error's cause.
    const broken = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${PING}`), { code: 'ECONNREFUSED' })
      });
    });
    await expect(sendMaintenanceHeartbeat({ MAINTENANCE_HEARTBEAT_URL: PING }, broken)).resolves.toBe('failed');
    const logged = output();
    expect(logged).toContain('maintenance.heartbeat_failed');
    // The network code names the failure...
    expect(logged).toContain('"errorClass":"ECONNREFUSED"');
    // ...and nothing carries the URL.
    expect(logged).not.toContain('hc-ping.com');
    expect(logged).not.toContain('5b7c1b8e');
  });
});

/**
 * The 2026-09-13 security review found the HTTP listener had no exception
 * boundary: `http.createServer(async …)` ignores the returned promise, so a
 * rejection escaping any route became an unhandled rejection and, on Node
 * 22, the end of the process. Two unauthenticated routes could reach it.
 * These tests pin the boundary's three outcomes and the process guards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const diagnostics = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../../../src/utils/diagnosticLog.js', () => ({
  writeDiagnostic: diagnostics.write,
  classifyDiagnosticError: (_error: unknown, fallback: string) => fallback
}));

import { installProcessGuards, withRequestBoundary } from '../../../src/mcp/requestBoundary.js';

function fakeResponse(headersSent = false) {
  const res = {
    headersSent,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn()
  };
  return res as unknown as ServerResponse & typeof res;
}

const req = { method: 'GET' } as IncomingMessage;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
}

describe('withRequestBoundary', () => {
  beforeEach(() => diagnostics.write.mockClear());

  it('leaves a request that completes alone', async () => {
    const res = fakeResponse();
    const handler = vi.fn(async () => undefined);
    withRequestBoundary(handler)(req, res);
    await settle();

    expect(handler).toHaveBeenCalledWith(req, res);
    expect(res.end).not.toHaveBeenCalled();
    expect(diagnostics.write).not.toHaveBeenCalled();
  });

  it('answers 500 and logs the class when a handler rejects before writing', async () => {
    const res = fakeResponse();
    withRequestBoundary(async () => {
      throw new Error('bucket unavailable');
    })(req, res);
    await settle();

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal Server Error');
    expect(res.destroy).not.toHaveBeenCalled();
    expect(diagnostics.write).toHaveBeenCalledWith(
      'error',
      'http.request_unhandled',
      expect.objectContaining({ method: 'GET', headersSent: false })
    );
    // The message text never reaches the log line.
    expect(JSON.stringify(diagnostics.write.mock.calls)).not.toContain('bucket unavailable');
  });

  it('catches a synchronous throw the same way', async () => {
    const res = fakeResponse();
    withRequestBoundary(() => {
      throw new TypeError('Invalid URL');
    })(req, res);
    await settle();

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalled();
  });

  it('closes the socket instead of writing when the response had started', async () => {
    const res = fakeResponse(true);
    withRequestBoundary(async () => {
      throw new Error('mid-stream');
    })(req, res);
    await settle();

    expect(res.destroy).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe('installProcessGuards', () => {
  const added: Array<[string, (...args: unknown[]) => void]> = [];
  let onSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    diagnostics.write.mockClear();
    delete (process as unknown as Record<string, unknown>).__letterIrlProcessGuards;
    onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      added.push([event, listener]);
      return process;
    }) as never);
  });

  afterEach(() => {
    onSpy.mockRestore();
    added.length = 0;
    delete (process as unknown as Record<string, unknown>).__letterIrlProcessGuards;
  });

  it('logs a stray rejection and keeps the process, logs an uncaught exception and exits', () => {
    const exit = vi.fn();
    installProcessGuards(exit);

    const rejection = added.find(([event]) => event === 'unhandledRejection');
    const exception = added.find(([event]) => event === 'uncaughtException');
    expect(rejection).toBeDefined();
    expect(exception).toBeDefined();

    rejection![1](new Error('nobody awaited me'));
    expect(diagnostics.write).toHaveBeenCalledWith('error', 'process.unhandled_rejection', expect.any(Object));
    expect(exit).not.toHaveBeenCalled();

    exception![1](new Error('boom'));
    expect(diagnostics.write).toHaveBeenCalledWith('error', 'process.uncaught_exception', expect.any(Object));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('registers once', () => {
    installProcessGuards(vi.fn());
    installProcessGuards(vi.fn());
    expect(added.filter(([event]) => event === 'unhandledRejection')).toHaveLength(1);
  });
});

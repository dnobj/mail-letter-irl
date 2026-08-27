import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  readRequestBody,
  RequestBodyTooLargeError,
  RequestBodyTimeoutError
} from '../../../src/utils/requestBody.js';

/**
 * Bounded body reading (#157).
 *
 * Before this, five handlers accumulated request bodies with `body += chunk`
 * and no cap. `parseRequestBody` had a 30-second timeout but no size limit, so
 * the bound was bandwidth x 30s - and `/webhooks/stripe` reaches it BEFORE
 * authentication, because Stripe signs the body and the signature cannot be
 * verified until it has been read. An unauthenticated POST could therefore
 * stream into memory until the process died.
 *
 * The two tests that matter most here are the lying content-length and the
 * split multi-byte character. Both are cases a naive implementation passes.
 */

/** A minimal IncomingMessage: an emitter with headers and a destroy() spy. */
function fakeRequest(headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    destroy: ReturnType<typeof vi.fn>;
  };
  req.headers = headers;
  req.destroy = vi.fn();
  return req;
}

const read = (req: EventEmitter, limitBytes: number, timeoutMs?: number) =>
  readRequestBody(req as unknown as IncomingMessage, { limitBytes, timeoutMs });

describe('readRequestBody', () => {
  it('returns a body inside the limit', async () => {
    const req = fakeRequest();
    const promise = read(req, 1024);
    req.emit('data', Buffer.from('{"ok":true}'));
    req.emit('end');

    await expect(promise).resolves.toBe('{"ok":true}');
  });

  it('refuses before reading when content-length already exceeds the limit', async () => {
    // The free early exit: no bytes are buffered at all.
    const req = fakeRequest({ 'content-length': '5000' });
    const promise = read(req, 1024);

    await expect(promise).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('refuses on actual bytes when there is NO content-length', async () => {
    // A chunked request declares no length. Trusting the header alone would
    // leave the only unbounded path wide open.
    const req = fakeRequest();
    const promise = read(req, 16);
    req.emit('data', Buffer.alloc(64, 0x61));

    await expect(promise).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('refuses a LYING content-length that understates the body', async () => {
    // The header is attacker-controlled. A implementation that checks only the
    // declared length accepts an unbounded stream from anyone willing to lie -
    // so the byte count, not the header, has to be authoritative.
    const req = fakeRequest({ 'content-length': '10' });
    const promise = read(req, 32);
    req.emit('data', Buffer.alloc(128, 0x62));

    await expect(promise).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(req.destroy).toHaveBeenCalled();
  });

  it('stops buffering once refused', async () => {
    const req = fakeRequest();
    const promise = read(req, 8);
    req.emit('data', Buffer.alloc(16, 0x63));
    await expect(promise).rejects.toBeInstanceOf(RequestBodyTooLargeError);

    // Further chunks must not be accumulated or re-settle the promise. The
    // destroy() is what actually stops the client sending; without it the
    // socket keeps filling and the rejection bounds nothing.
    expect(() => req.emit('data', Buffer.alloc(16, 0x64))).not.toThrow();
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a multi-byte character split across two chunks intact', async () => {
    // The bug the old `body += chunk.toString()` had on all five paths: each
    // chunk was decoded independently, so a UTF-8 sequence straddling a TCP
    // segment boundary became two replacement characters. For the Stripe
    // webhook that silently corrupts the bytes the signature is computed over;
    // for letter content it corrupts what the customer wrote.
    const req = fakeRequest();
    const full = Buffer.from('héllo wörld — ✉', 'utf8');
    const promise = read(req, 1024);

    // Split at a byte that is mid-character.
    req.emit('data', full.subarray(0, 2));
    req.emit('data', full.subarray(2));
    req.emit('end');

    await expect(promise).resolves.toBe('héllo wörld — ✉');
    expect(await promise).not.toContain('�');
  });

  it('times out rather than waiting forever on a stalled client', async () => {
    vi.useFakeTimers();
    try {
      const req = fakeRequest();
      const promise = read(req, 1024, 50);
      req.emit('data', Buffer.from('partial'));
      vi.advanceTimersByTime(51);

      await expect(promise).rejects.toBeInstanceOf(RequestBodyTimeoutError);
      expect(req.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries a status code so a refusal is not reported as a parse failure', async () => {
    expect(new RequestBodyTooLargeError(10).statusCode).toBe(413);
    expect(new RequestBodyTimeoutError().statusCode).toBe(408);
  });

  it('never puts a size from the request into the error message', async () => {
    // Error strings reach logs. The limit is ours to state; the body's actual
    // size is the caller's data.
    const error = new RequestBodyTooLargeError(1024);
    expect(error.message).not.toMatch(/\d/);
  });

  it('surfaces a socket error', async () => {
    const req = fakeRequest();
    const promise = read(req, 1024);
    req.emit('error', new Error('ECONNRESET'));

    await expect(promise).rejects.toThrow('ECONNRESET');
  });
});

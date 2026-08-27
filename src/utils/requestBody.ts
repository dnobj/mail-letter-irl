import type { IncomingMessage } from 'node:http';
import { positiveIntegerSetting } from './envSettings.js';

/**
 * Bounded request-body reading (#157).
 *
 * Five handlers previously accumulated request bodies with `body += chunk` and
 * no cap. `parseRequestBody` had a 30-second timeout but no byte limit, so the
 * bound was bandwidth x 30s rather than a size - and `/webhooks/stripe` is
 * necessarily pre-authentication, because Stripe signs the body and the
 * signature cannot be checked until it has been read. An unauthenticated POST
 * could therefore stream into memory until the process died, which on a
 * container with a fixed memory limit is a single-request denial of service by
 * anyone who knows the URL.
 *
 * Two things beyond the limit itself:
 *
 * Buffers are collected and concatenated ONCE rather than decoded per chunk.
 * `chunk.toString()` decodes each chunk independently, so a multi-byte UTF-8
 * sequence split across a TCP segment boundary decodes to two replacement
 * characters. For the Stripe webhook that silently corrupts the raw body the
 * signature is computed over; for letter content it corrupts what the customer
 * wrote. The old code had that bug on all five paths.
 *
 * And the byte count is authoritative, not `content-length`. The header is a
 * free early exit when it is present and already too large, but a chunked
 * request has none, and a lying one must not be believed.
 */

export class RequestBodyTooLargeError extends Error {
  readonly statusCode = 413;
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    // No sizes from the request itself - an error message is a place values
    // leak, and the limit is ours to state.
    super('Request body exceeds the configured limit');
    this.name = 'RequestBodyTooLargeError';
    this.limitBytes = limitBytes;
  }
}

export class RequestBodyTimeoutError extends Error {
  readonly statusCode = 408;

  constructor() {
    super('Request body timeout');
    this.name = 'RequestBodyTimeoutError';
  }
}

/**
 * Limits, largest first. Each is generous against the biggest LEGITIMATE
 * payload for its route rather than tight against the smallest:
 *
 *   MCP      - tool calls carrying letter text. A 1 MB body is on the order of
 *              a 500-page letter. No tool input accepts binary or base64 (the
 *              image paths pass URLs, and the server fetches the bytes itself),
 *              so nothing legitimate approaches this.
 *   webhook  - Stripe event payloads. Well under 1 MB in practice; sized to
 *              avoid ever rejecting a real event, since a rejected webhook
 *              means an unbooked payment.
 *   json api - admin, credit, PAT and return-address calls. All small objects.
 *
 * Env-overridable through the house helper so an operator can raise one without
 * a deploy if something legitimate is ever refused - the failure mode of a limit
 * set too low is a broken feature, and that needs a faster remedy than a build.
 */
export const MCP_BODY_LIMIT_BYTES = positiveIntegerSetting(
  'LETTER_IRL_MCP_BODY_LIMIT_BYTES', 1024 * 1024, 1024, 16 * 1024 * 1024
);
export const WEBHOOK_BODY_LIMIT_BYTES = positiveIntegerSetting(
  'LETTER_IRL_WEBHOOK_BODY_LIMIT_BYTES', 1024 * 1024, 1024, 16 * 1024 * 1024
);
export const JSON_API_BODY_LIMIT_BYTES = positiveIntegerSetting(
  'LETTER_IRL_JSON_BODY_LIMIT_BYTES', 256 * 1024, 1024, 16 * 1024 * 1024
);

export interface ReadRequestBodyOptions {
  limitBytes: number;
  timeoutMs?: number;
}

/**
 * Read a request body as UTF-8, refusing anything past `limitBytes`.
 *
 * On refusal the request is destroyed rather than merely rejected: without that
 * the client keeps sending and the socket keeps buffering, so the promise
 * settling would not actually stop the memory growth it exists to bound.
 */
export function readRequestBody(
  req: IncomingMessage,
  options: ReadRequestBodyOptions
): Promise<string> {
  const { limitBytes, timeoutMs = 30_000 } = options;

  return new Promise((resolve, reject) => {
    // Free early exit. Only trusted to REJECT, never to admit: a chunked
    // request has no content-length, and a declared one can be a lie.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      req.destroy();
      reject(new RequestBodyTooLargeError(limitBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        req.destroy();
        reject(new RequestBodyTimeoutError());
      });
    }, timeoutMs);

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > limitBytes) {
        finish(() => {
          req.destroy();
          reject(new RequestBodyTooLargeError(limitBytes));
        });
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      // Concatenated and decoded once, so a multi-byte character split across
      // two chunks survives intact.
      finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.on('error', (error) => {
      finish(() => reject(error));
    });
  });
}

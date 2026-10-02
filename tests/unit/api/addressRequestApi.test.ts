/**
 * The address request page's API (#604): public, the token in the body, 404
 * alike for a link it does not know and while the feature is off. An answer
 * is checked as a preview checks an address before it is kept. The service's
 * statements are tested against PostgreSQL in addressRequests.postgres.test.ts.
 */

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/addressRequestService.js', () => ({
  readAddressRequestPage: vi.fn(),
  answerAddressRequest: vi.fn(),
  declineAddressRequest: vi.fn()
}));
vi.mock('../../../src/services/providers/index.js', () => ({ getLetterProvider: vi.fn() }));
vi.mock('../../../src/api/middleware/rateLimit.js', () => ({ rateLimitMiddlewareWithGlobal: vi.fn(() => false) }));
vi.mock('../../../src/utils/diagnosticLog.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/diagnosticLog.js')>()),
  writeDiagnostic: vi.fn()
}));

import {
  answerAddressRequest,
  declineAddressRequest,
  readAddressRequestPage
} from '../../../src/services/addressRequestService.js';
import { getLetterProvider } from '../../../src/services/providers/index.js';
import { rateLimitMiddlewareWithGlobal } from '../../../src/api/middleware/rateLimit.js';
import { writeDiagnostic } from '../../../src/utils/diagnosticLog.js';
import { givenAddressOf, handleAddressRequestApiRequest } from '../../../src/api/addressRequestApi.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
const ORIGIN = 'https://letterirl.example';
const WAITING = { state: 'waiting', senderFirstName: 'Pat', expiresAt: '2026-10-09T14:00:00.000Z' };
const ADDRESS = { addressLine1: ' 1 Main  St ', addressLine2: '  ', city: 'Tucson', state: 'az', postalCode: '85701' };

function request(method: string, body?: string): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    method,
    headers: { 'content-type': 'application/json' }
  }) as unknown as IncomingMessage;
}

function response() {
  const state = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    statusCode: 0,
    headersSent: false,
    setHeader(name: string, value: unknown) {
      state.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      state.status = this.statusCode;
      state.body = chunk ?? '';
    }
  };
  return { res: res as unknown as ServerResponse, state, json: () => JSON.parse(state.body) };
}

async function call(route: string, body?: unknown, method = 'POST') {
  const { res, state, json } = response();
  const handled = await handleAddressRequestApiRequest(
    request(method, body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)),
    res,
    `/api/public/address-requests/${route}`,
    ORIGIN
  );
  return { handled, status: state.status, headers: state.headers, json: state.body ? json() : null };
}

const validateAddress = vi.fn();

beforeEach(() => {
  vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', 'true');
  vi.mocked(readAddressRequestPage).mockReset().mockResolvedValue(WAITING as never);
  vi.mocked(answerAddressRequest).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(declineAddressRequest).mockReset().mockResolvedValue({ ok: true });
  validateAddress.mockReset().mockResolvedValue({ status: 'verified', originalAddress: {}, errors: [] });
  vi.mocked(getLetterProvider).mockReturnValue({ validateAddress } as never);
  vi.mocked(rateLimitMiddlewareWithGlobal).mockClear();
  vi.mocked(writeDiagnostic).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the address request routes (#604)', () => {
  it('leaves other paths to the server', async () => {
    const { res } = response();
    await expect(handleAddressRequestApiRequest(request('POST', '{}'), res, '/api/public/gift/ABC', ORIGIN)).resolves.toBe(false);
  });

  it('answers 404 alike for an unknown route, a GET, and while address requests are off', async () => {
    for (const [route, method] of [['nope', 'POST'], ['page', 'GET']] as const) {
      const answer = await call(route, { token: TOKEN }, method);
      expect(answer, `${method} ${route}`).toMatchObject({ handled: true, status: 404, json: { reason: 'not_found' } });
    }
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', '');
    await expect(call('page', { token: TOKEN })).resolves.toMatchObject({ status: 404, json: { reason: 'not_found' } });
    expect(readAddressRequestPage).not.toHaveBeenCalled();
  });

  it('rate-limits each route in its own bucket before reading anything', async () => {
    vi.mocked(rateLimitMiddlewareWithGlobal).mockReturnValueOnce(true);
    await call('page', { token: TOKEN });
    expect(rateLimitMiddlewareWithGlobal).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'address_public');
    expect(readAddressRequestPage).not.toHaveBeenCalled();
  });

  it("gives the page the sender's first name, the state and the expiry, uncached and without a referrer", async () => {
    const answer = await call('page', { token: TOKEN });
    // Exactly these three: nothing more of the request reaches the page.
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual(WAITING);
    expect(answer.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    });
    expect(readAddressRequestPage).toHaveBeenCalledWith(TOKEN);

    vi.mocked(readAddressRequestPage).mockResolvedValueOnce(null);
    await expect(call('page', { token: 'nope' })).resolves.toMatchObject({ status: 404, json: { reason: 'not_found' } });
  });

  it('refuses a body too large or not a JSON object', async () => {
    await expect(call('page', `{"token":"${'x'.repeat(5000)}"}`)).resolves.toMatchObject({ status: 413, json: { reason: 'too_large' } });
    for (const body of ['not json', '[1]', '"x"', '']) {
      await expect(call('page', body), body).resolves.toMatchObject({ status: 400, json: { reason: 'invalid' } });
    }
  });

  it('takes a decline, and says why a link it could not change was refused', async () => {
    await expect(call('decline', { token: TOKEN })).resolves.toMatchObject({ status: 200, json: { ok: true } });
    expect(declineAddressRequest).toHaveBeenCalledWith(TOKEN);
    vi.mocked(declineAddressRequest).mockResolvedValueOnce({ ok: false, refusal: 'answered' });
    await expect(call('decline', { token: TOKEN })).resolves.toMatchObject({ status: 409, json: { reason: 'answered' } });
    vi.mocked(declineAddressRequest).mockResolvedValueOnce({ ok: false, refusal: 'not_found' });
    await expect(call('decline', { token: TOKEN })).resolves.toMatchObject({ status: 404, json: { reason: 'not_found' } });
  });

  it('keeps a verified answer trimmed, with no name or empty line of its own', async () => {
    await expect(call('answer', { token: TOKEN, address: ADDRESS })).resolves.toMatchObject({ status: 200, json: { ok: true } });
    expect(validateAddress).toHaveBeenCalledWith({
      line1: '1 Main St',
      line2: undefined,
      city: 'Tucson',
      state: 'AZ',
      postalCode: '85701',
      country: 'US'
    });
    expect(answerAddressRequest).toHaveBeenCalledWith(TOKEN, {
      addressLine1: '1 Main St',
      city: 'Tucson',
      state: 'AZ',
      postalCode: '85701',
      country: 'US'
    });
  });

  it("keeps the recipient's own name, and a corrected address as corrected", async () => {
    validateAddress.mockResolvedValueOnce({
      status: 'corrected',
      originalAddress: {},
      errors: [],
      verifiedAddress: { line1: '1 MAIN ST', line2: 'APT 2', city: 'TUCSON', state: 'AZ', postalCode: '85701-1234', country: 'us' }
    });
    await call('answer', { token: TOKEN, address: { ...ADDRESS, name: '  Ruth   Example ' } });
    expect(answerAddressRequest).toHaveBeenCalledWith(TOKEN, {
      name: 'Ruth Example',
      addressLine1: '1 MAIN ST',
      addressLine2: 'APT 2',
      city: 'TUCSON',
      state: 'AZ',
      postalCode: '85701-1234',
      country: 'US'
    });
  });

  it('refuses an address USPS cannot reach, keeping nothing', async () => {
    validateAddress.mockResolvedValueOnce({
      status: 'failed',
      originalAddress: { line1: '1 Nowhere Rd' },
      errors: [{ message: 'Address not found' }]
    });
    const answer = await call('answer', { token: TOKEN, address: ADDRESS });
    expect(answer).toMatchObject({ status: 422, json: { reason: 'undeliverable' } });
    expect(answer.json.message).toContain('Your address could not be delivered to: Address not found.');
    expect(answerAddressRequest).not.toHaveBeenCalled();
  });

  it('keeps an address the service could not check, as a preview does', async () => {
    validateAddress.mockResolvedValueOnce({ status: 'failed', originalAddress: {}, errors: [], transportError: true });
    await expect(call('answer', { token: TOKEN, address: ADDRESS })).resolves.toMatchObject({ status: 200 });
    expect(answerAddressRequest).toHaveBeenCalledTimes(1);
  });

  it('checks the link before the address: a used or unknown one costs no verification', async () => {
    vi.mocked(readAddressRequestPage).mockResolvedValueOnce({ ...WAITING, state: 'expired' } as never);
    await expect(call('answer', { token: TOKEN, address: ADDRESS })).resolves.toMatchObject({ status: 409, json: { reason: 'expired' } });
    vi.mocked(readAddressRequestPage).mockResolvedValueOnce(null);
    await expect(call('answer', { token: TOKEN, address: ADDRESS })).resolves.toMatchObject({ status: 404 });
    expect(validateAddress).not.toHaveBeenCalled();
    expect(answerAddressRequest).not.toHaveBeenCalled();
  });

  it('says which fields are wrong, before verifying anything', async () => {
    const answer = await call('answer', {
      token: TOKEN,
      address: { addressLine1: '', city: 'C'.repeat(61), state: 'XX', postalCode: '8570', name: 'Ruth\u0007' }
    });
    expect(answer).toMatchObject({ status: 400, json: { reason: 'invalid', fields: ['name', 'addressLine1', 'city', 'state', 'postalCode'] } });
    expect(validateAddress).not.toHaveBeenCalled();
  });

  it('answers a fault with nothing of the request, and logs its class only', async () => {
    vi.mocked(readAddressRequestPage).mockRejectedValueOnce(Object.assign(new Error(`timeout reading ${TOKEN}`), { code: 'ETIMEDOUT' }));
    await expect(call('page', { token: TOKEN })).resolves.toMatchObject({ status: 500, json: { reason: 'unavailable' } });
    expect(writeDiagnostic).toHaveBeenCalledWith('error', 'address_request.public_failed', { route: 'page', errorClass: 'ETIMEDOUT' });
  });

  it('never logs the token, a name or an address', async () => {
    await call('answer', { token: TOKEN, address: { ...ADDRESS, name: 'Ruth Example' } });
    await call('decline', { token: TOKEN });
    const logged = JSON.stringify(vi.mocked(writeDiagnostic).mock.calls);
    for (const secret of [TOKEN, 'Ruth', 'Main', 'Tucson', '85701']) expect(logged, secret).not.toContain(secret);
    expect(logged).toContain('answered');
  });
});

describe("the recipient's address fields (#604)", () => {
  it('takes every USPS state and territory code, in either case, and ZIP or ZIP+4', () => {
    for (const state of ['dc', 'PR', 'gu', 'AE', 'WY']) {
      expect(givenAddressOf({ ...ADDRESS, state }).ok, state).toBe(true);
    }
    for (const postalCode of ['85701', '85701-1234']) expect(givenAddressOf({ ...ADDRESS, postalCode }).ok, postalCode).toBe(true);
    for (const postalCode of ['8570', '857011', '85701-12', 'ABCDE']) {
      expect(givenAddressOf({ ...ADDRESS, postalCode }), postalCode).toEqual({ ok: false, fields: ['postalCode'] });
    }
  });

  it('refuses a field with hidden or unprintable characters, or too long', () => {
    expect(givenAddressOf({ ...ADDRESS, addressLine1: '1 Main St\u202E' })).toEqual({ ok: false, fields: ['addressLine1'] });
    expect(givenAddressOf({ ...ADDRESS, city: 'Tucson \u{1F600}' })).toEqual({ ok: false, fields: ['city'] });
    expect(givenAddressOf({ ...ADDRESS, addressLine2: 'A'.repeat(101) })).toEqual({ ok: false, fields: ['addressLine2'] });
    expect(givenAddressOf({ ...ADDRESS, name: 7 })).toEqual({ ok: false, fields: ['name'] });
    expect(givenAddressOf(null)).toEqual({ ok: false, fields: ['addressLine1', 'city', 'state', 'postalCode'] });
  });
});

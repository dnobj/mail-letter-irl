import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * /api/signature (#608): the website's signature page reads, saves and
 * removes the saved signature through the same services as set_signature,
 * get_signature and clear_signature, with the same scopes.
 */

vi.mock('../../../src/api/middleware/restAuth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/restAuth.js')>()),
  authenticateRestRequest: vi.fn(),
  sendRestAuthFailure: vi.fn()
}));
vi.mock('../../../src/api/middleware/rateLimit.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/api/middleware/rateLimit.js')>()),
  rateLimitAccount: vi.fn()
}));
vi.mock('../../../src/utils/requestBody.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/requestBody.js')>()),
  readRequestBody: vi.fn()
}));
vi.mock('../../../src/db/index.js', () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/services/signatureService.js', () => ({
  getSignature: vi.fn(),
  saveSignature: vi.fn(),
  clearSignature: vi.fn()
}));
vi.mock('../../../src/services/signatureImage.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/services/signatureImage.js')>()),
  cleanSignatureImage: vi.fn()
}));

import { authenticateRestRequest, sendRestAuthFailure } from '../../../src/api/middleware/restAuth.js';
import { rateLimitAccount } from '../../../src/api/middleware/rateLimit.js';
import { readRequestBody, RequestBodyTooLargeError, RequestBodyTimeoutError } from '../../../src/utils/requestBody.js';
import { clearSignature, getSignature, saveSignature } from '../../../src/services/signatureService.js';
import { cleanSignatureImage, SignatureImageError } from '../../../src/services/signatureImage.js';
import { ImageProcessingError } from '../../../src/services/imageService.js';
import {
  handleSignatureApiRequest,
  pictureFromBody,
  SIGNATURE_BODY_LIMIT_BYTES
} from '../../../src/api/signatureApiHandler.js';
import { requiredRestScopes } from '../../../src/auth/restScopes.js';

const USER = 'auth0|signer';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PNG_URI = `data:image/png;base64,${PNG.toString('base64')}`;
const SAVED = {
  width: 300,
  height: 90,
  useByDefault: true,
  createdAt: '2026-10-02T14:00:00.000Z',
  updatedAt: '2026-10-03T09:30:00.000Z'
};

function call(method: string, path = '/api/signature') {
  const captured = { status: 0, body: '', headers: {} as Record<string, string> };
  const res = {
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      captured.status = (this as unknown as { statusCode: number }).statusCode;
      captured.body = chunk ?? '';
    }
  } as unknown as ServerResponse;
  const req = { method, url: path, headers: { host: 'api.test' } } as unknown as IncomingMessage;
  return handleSignatureApiRequest(req, res, path).then(handled => ({
    handled,
    status: captured.status,
    headers: captured.headers,
    body: captured.body ? JSON.parse(captured.body) : null
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', 'pdf');
  vi.mocked(authenticateRestRequest).mockResolvedValue({ ok: true, user: { userId: USER, scopes: ['mail:read', 'mail:draft'] } } as never);
  vi.mocked(rateLimitAccount).mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/api/signature (#608)', () => {
  it('is not this handler\'s for any other path', async () => {
    expect((await call('GET', '/api/signatures')).handled).toBe(false);
    expect((await call('GET', '/api/signature/1')).handled).toBe(false);
    expect(authenticateRestRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['the flag off', '', 'pdf'],
    ['the legacy renderer', 'true', 'html']
  ])('answers 404 with %s, before authenticating', async (_name, flag, renderer) => {
    vi.stubEnv('LETTER_IRL_SIGNATURES_ENABLED', flag);
    vi.stubEnv('LETTER_IRL_PRINT_RENDERER', renderer);
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(await call(method), method).toMatchObject({ handled: true, status: 404 });
    }
    expect(authenticateRestRequest).not.toHaveBeenCalled();
  });

  it("authenticates with each route's scope, and stops on a refusal or the account's rate limit", async () => {
    vi.mocked(authenticateRestRequest).mockResolvedValueOnce({ ok: false, status: 401 } as never);
    expect((await call('GET')).handled).toBe(true);
    expect(sendRestAuthFailure).toHaveBeenCalledTimes(1);
    expect(authenticateRestRequest).toHaveBeenCalledWith(expect.anything(), requiredRestScopes('GET', '/api/signature'));
    expect(requiredRestScopes('GET', '/api/signature')).toEqual(['mail:read']);
    expect(requiredRestScopes('POST', '/api/signature')).toEqual(['mail:draft']);
    expect(requiredRestScopes('DELETE', '/api/signature')).toEqual(['mail:draft']);

    vi.mocked(rateLimitAccount).mockResolvedValueOnce(true);
    expect((await call('DELETE')).handled).toBe(true);
    expect(rateLimitAccount).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), USER, 'api_account');
    expect(clearSignature).not.toHaveBeenCalled();
    expect(getSignature).not.toHaveBeenCalled();
  });

  describe('GET', () => {
    it('gives the saved signature with its picture, not to be cached', async () => {
      vi.mocked(getSignature).mockResolvedValue({ ...SAVED, png: PNG });
      const { status, body, headers } = await call('GET');
      expect(status).toBe(200);
      expect(body).toEqual({ saved: true, width: 300, height: 90, savedAt: SAVED.updatedAt, image: PNG_URI });
      expect(headers['cache-control']).toBe('no-store');
      expect(getSignature).toHaveBeenCalledWith(USER);
    });

    it('says none is saved', async () => {
      vi.mocked(getSignature).mockResolvedValue(null);
      expect(await call('GET')).toMatchObject({ status: 200, body: { saved: false } });
    });
  });

  describe('POST', () => {
    beforeEach(() => {
      vi.mocked(readRequestBody).mockResolvedValue(JSON.stringify({ image: PNG_URI }));
      vi.mocked(cleanSignatureImage).mockResolvedValue({ png: PNG, width: 300, height: 90 });
      vi.mocked(saveSignature).mockResolvedValue({ ok: true, replaced: true, signature: SAVED });
    });

    it('cleans and saves the picture, within its own body limit, and answers with the cleaned one', async () => {
      const { status, body } = await call('POST');
      expect(status).toBe(200);
      expect(readRequestBody).toHaveBeenCalledWith(expect.anything(), { limitBytes: SIGNATURE_BODY_LIMIT_BYTES });
      expect(cleanSignatureImage).toHaveBeenCalledWith(PNG, USER);
      expect(saveSignature).toHaveBeenCalledWith(USER, { png: PNG, width: 300, height: 90 });
      expect(body).toEqual({ saved: true, replaced: true, width: 300, height: 90, savedAt: SAVED.updatedAt, image: PNG_URI });
    });

    it('refuses a body that is not a picture as a data URI', async () => {
      for (const sent of ['not json', '[]', '{}', '{"image":7}', '{"image":"https://example.invalid/sig.png"}', '{"image":"data:image/gif;base64,R0lGOD=="}']) {
        vi.mocked(readRequestBody).mockResolvedValueOnce(sent);
        expect(await call('POST'), sent).toMatchObject({ status: 400, body: { reason: 'invalid' } });
      }
      expect(cleanSignatureImage).not.toHaveBeenCalled();
    });

    it("says the cleaning's refusal, and an unopenable picture's, in the person's words", async () => {
      vi.mocked(cleanSignatureImage).mockRejectedValueOnce(new SignatureImageError('NO_SIGNATURE_FOUND', 'No signature found.'));
      expect(await call('POST')).toMatchObject({ status: 422, body: { reason: 'NO_SIGNATURE_FOUND', message: 'No signature found.' } });
      vi.mocked(cleanSignatureImage).mockRejectedValueOnce(new ImageProcessingError('UNSUPPORTED_FORMAT', 'Use PNG, JPEG or WebP.'));
      expect(await call('POST')).toMatchObject({ status: 422, body: { reason: 'UNSUPPORTED_FORMAT', message: 'Use PNG, JPEG or WebP.' } });
      vi.mocked(cleanSignatureImage).mockRejectedValueOnce(new ImageProcessingError('SERVICE_BUSY', 'Busy.'));
      expect(await call('POST')).toMatchObject({ status: 503, body: { reason: 'SERVICE_BUSY' } });
      expect(saveSignature).not.toHaveBeenCalled();
    });

    it('answers 413 for a body over the limit, 408 for one too slow, and 403 for an erased account', async () => {
      vi.mocked(readRequestBody).mockRejectedValueOnce(new RequestBodyTooLargeError(SIGNATURE_BODY_LIMIT_BYTES));
      expect(await call('POST')).toMatchObject({ status: 413, body: { reason: 'too_large' } });
      vi.mocked(readRequestBody).mockRejectedValueOnce(new RequestBodyTimeoutError());
      expect(await call('POST')).toMatchObject({ status: 408, body: { reason: 'timeout' } });
      vi.mocked(saveSignature).mockResolvedValueOnce({ ok: false, refusal: 'account_closed' });
      expect(await call('POST')).toMatchObject({ status: 403, body: { reason: 'account_closed' } });
    });

    it('answers 500 for anything else, without its message', async () => {
      vi.mocked(saveSignature).mockRejectedValueOnce(new Error('connection to auth0|signer refused'));
      const { status, body } = await call('POST');
      expect(status).toBe(500);
      expect(JSON.stringify(body)).not.toContain('auth0');
    });
  });

  describe('DELETE', () => {
    it('removes the saved signature, and says whether there was one', async () => {
      vi.mocked(clearSignature).mockResolvedValueOnce(true);
      expect(await call('DELETE')).toMatchObject({ status: 200, body: { removed: true } });
      vi.mocked(clearSignature).mockResolvedValueOnce(false);
      expect(await call('DELETE')).toMatchObject({ status: 200, body: { removed: false } });
      expect(clearSignature).toHaveBeenCalledWith(USER);
    });
  });

  it('answers 405 for another method', async () => {
    expect(await call('PUT')).toMatchObject({ status: 405 });
  });
});

describe('pictureFromBody', () => {
  it('takes a PNG, JPEG or WebP data URI in "image", and decodes it', () => {
    expect(pictureFromBody(JSON.stringify({ image: PNG_URI }))).toEqual(PNG);
    expect(pictureFromBody(JSON.stringify({ image: 'data:image/jpeg;base64,/9j/4A==' }))).toEqual(Buffer.from('/9j/4A==', 'base64'));
    expect(pictureFromBody(JSON.stringify({ image: 'data:image/webp;base64,UklGRg==' }))).toEqual(Buffer.from('UklGRg==', 'base64'));
    expect(pictureFromBody(JSON.stringify({ image: `${PNG_URI}\n` }))).toBeNull();
    expect(pictureFromBody(JSON.stringify({ image: ` ${PNG_URI}` }))).toBeNull();
    expect(pictureFromBody('null')).toBeNull();
  });
});

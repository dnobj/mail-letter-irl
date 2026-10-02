/**
 * The address request tools (#604): request_address makes a private link,
 * get_address_request says what became of it, cancel_address_request closes
 * it. The service's statements are tested against PostgreSQL in
 * addressRequests.postgres.test.ts; here it is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/addressRequestService.js', () => ({
  createAddressRequest: vi.fn(),
  getAddressRequest: vi.fn(),
  cancelAddressRequest: vi.fn()
}));
vi.mock('../../../src/services/returnAddressService.js', () => ({ getReturnAddress: vi.fn() }));

import { AccountErasedError } from '../../../src/auth/accountErased.js';

import {
  cancelAddressRequest,
  createAddressRequest,
  getAddressRequest,
  type AddressRequest
} from '../../../src/services/addressRequestService.js';
import { getReturnAddress } from '../../../src/services/returnAddressService.js';
import { requestAddressTool } from '../../../src/tools/requestAddress.js';
import { getAddressRequestTool } from '../../../src/tools/getAddressRequest.js';
import { cancelAddressRequestTool } from '../../../src/tools/cancelAddressRequest.js';
import {
  AddressRequestRefusedError,
  addressRequestUrl,
  firstNameFromSaved,
  linkExpiry,
  recipientNameOf,
  senderFirstNameOf
} from '../../../src/tools/addressRequestShared.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const REQUEST_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
const ADDRESS = {
  name: 'Ruth Example',
  addressLine1: '1 Main St',
  addressLine2: 'Apt 2',
  city: 'Tucson',
  state: 'AZ',
  postalCode: '85701',
  country: 'US' as const
};

let logger: { info: ReturnType<typeof vi.fn> };

function context(): ToolContext {
  logger = { info: vi.fn() };
  return {
    user: { userId: 'auth0|sender' } as unknown as ToolContext['user'],
    correlationId: 'corr-1',
    logger: { ...logger, warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never,
    now: () => new Date('2026-10-02T14:00:00Z'),
    persist: vi.fn()
  };
}

const request = (overrides: Partial<AddressRequest> = {}): AddressRequest => ({
  requestId: REQUEST_ID,
  state: 'waiting',
  recipientName: 'Ruth',
  senderFirstName: 'Pat',
  createdAt: '2026-10-02T14:00:00.000Z',
  expiresAt: '2026-10-09T14:00:00.000Z',
  closedAt: null,
  address: null,
  ...overrides
});

const refusal = (promise: Promise<unknown>) => promise.then(
  () => { throw new Error('expected a refusal'); },
  (error: unknown) => {
    expect(error).toBeInstanceOf(AddressRequestRefusedError);
    const { code, message } = error as AddressRequestRefusedError;
    return { code, message };
  }
);

beforeEach(() => {
  vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', 'true');
  vi.stubEnv('LETTER_IRL_WEBSITE_BASE_URL', 'https://letterirl.example');
  vi.mocked(createAddressRequest).mockReset().mockResolvedValue({ ok: true, request: request(), token: TOKEN });
  vi.mocked(getAddressRequest).mockReset().mockResolvedValue(request());
  vi.mocked(cancelAddressRequest).mockReset();
  vi.mocked(getReturnAddress).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('request_address (#604)', () => {
  const run = (input: Record<string, unknown>) => requestAddressTool.handler(input as never, context());

  it('makes a link on the website and says to share it, sending nothing', async () => {
    const output = await run({ recipientName: '  Ruth   Example ', senderFirstName: 'Pat' });
    expect(createAddressRequest).toHaveBeenCalledWith({ userId: 'auth0|sender', recipientName: 'Ruth Example', senderFirstName: 'Pat' });
    expect(output).toEqual({
      requestId: REQUEST_ID,
      status: 'waiting',
      url: `https://letterirl.example/address#${TOKEN}`,
      recipientName: 'Ruth Example',
      senderFirstName: 'Pat',
      expiresAt: '2026-10-09T14:00:00.000Z',
      message:
        `Here is the link that asks Ruth Example for their address: https://letterirl.example/address#${TOKEN} ` +
        "Letter IRL doesn't send it: share it with Ruth Example yourself, by text or email. " +
        'It works once, until October 9 at 10:00 AM EDT, and the page shows only the first name Pat. ' +
        'Once Ruth Example answers, the mail can be previewed with their address.'
    });
  });

  it('logs the request id only: never the link, the names or the token', async () => {
    await run({ recipientName: 'Ruth', senderFirstName: 'Pat' });
    expect(logger.info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logger.info.mock.calls[0]);
    expect(logged).toContain(REQUEST_ID);
    for (const secret of [TOKEN, 'Ruth', 'Pat']) expect(logged).not.toContain(secret);
  });

  it("takes the first name from the saved return address when none is given, and asks when there is none", async () => {
    vi.mocked(getReturnAddress).mockResolvedValue({ name: 'Pat  Q. Sender', addressLine1: '1 A St', city: 'X', state: 'IL', postalCode: '62701', country: 'US' });
    await run({ recipientName: 'Ruth' });
    expect(createAddressRequest).toHaveBeenLastCalledWith(expect.objectContaining({ senderFirstName: 'Pat' }));

    vi.mocked(getReturnAddress).mockResolvedValue(null);
    await expect(refusal(run({ recipientName: 'Ruth' }))).resolves.toMatchObject({ code: 'SENDER_NAME_REQUIRED' });
    // A saved name the page could not show as a first name is no default either.
    vi.mocked(getReturnAddress).mockResolvedValue({ name: 'www.example.com', addressLine1: '1 A St', city: 'X', state: 'IL', postalCode: '62701', country: 'US' });
    await expect(refusal(run({ recipientName: 'Ruth', senderFirstName: '  ' }))).resolves.toMatchObject({ code: 'SENDER_NAME_REQUIRED' });
    expect(createAddressRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses an account erased while it waited for the lock, as every closed account is refused', async () => {
    vi.mocked(createAddressRequest).mockResolvedValueOnce({ ok: false, refusal: 'account_closed' });
    await expect(run({ recipientName: 'Ruth', senderFirstName: 'Pat' })).rejects.toBeInstanceOf(AccountErasedError);
  });

  it('refuses each cap with what to do', async () => {
    vi.mocked(createAddressRequest).mockResolvedValueOnce({ ok: false, refusal: 'waiting_cap', cap: 10 });
    await expect(refusal(run({ recipientName: 'Ruth', senderFirstName: 'Pat' }))).resolves.toEqual({
      code: 'TOO_MANY_WAITING',
      message: 'This account has 10 address requests waiting for an answer. cancel_address_request closes one that is no longer needed.'
    });
    vi.mocked(createAddressRequest).mockResolvedValueOnce({ ok: false, refusal: 'daily_cap', cap: 20 });
    await expect(refusal(run({ recipientName: 'Ruth', senderFirstName: 'Pat' }))).resolves.toEqual({
      code: 'TOO_MANY_TODAY',
      message: 'This account has made 20 address requests in the last day. Try again tomorrow.'
    });
  });

  it('refuses a name it cannot keep, before making anything', async () => {
    for (const recipientName of ['', '   ', 'x'.repeat(101), 'Ruth\u202Ehtap', 'Ruth\u0007', 42]) {
      await expect(refusal(run({ recipientName, senderFirstName: 'Pat' })), String(recipientName)).resolves.toMatchObject({
        code: 'RECIPIENT_NAME_INVALID'
      });
    }
    for (const senderFirstName of [
      'visit evil.example', 'Pat!', 'https://x.example', '1Pat', 'P'.repeat(41), 'Pat\u200B', 7,
      'Send money now', 'Click the link', 'Jean Luc Picard', 'e.vil', 'J.R.R.R.R.', "Pat'", "'Pat", "Pat''s"
    ]) {
      await expect(refusal(run({ recipientName: 'Ruth', senderFirstName })), String(senderFirstName)).resolves.toMatchObject({
        code: 'SENDER_NAME_INVALID'
      });
    }
    expect(createAddressRequest).not.toHaveBeenCalled();
  });

  it('refuses while address requests are off, whatever a cached tool list says', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', '');
    await expect(refusal(run({ recipientName: 'Ruth', senderFirstName: 'Pat' }))).resolves.toMatchObject({ code: 'ADDRESS_REQUESTS_OFF' });
    expect(createAddressRequest).not.toHaveBeenCalled();
  });

  it('describes when to use it and when not, with the days a link lasts', () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUEST_LINK_DAYS', '5');
    const description = (requestAddressTool.description as (client: never) => string)(undefined as never);
    expect(description).toContain("whose U.S. mailing address they don't know");
    expect(description).toContain('Letter IRL never contacts them');
    expect(description).toContain('for 5 days');
    expect(description).toContain('Do not use it for an address the person already has');
    expect(description).toContain('Each call makes a new link, and an account may make 20 a day, so make one per recipient.');
  });
});

describe('get_address_request (#604)', () => {
  const run = (input: Record<string, unknown>) => getAddressRequestTool.handler(input as never, context());

  it.each([
    ['waiting', {}, "Ruth hasn't answered yet. The link works until October 9 at 10:00 AM EDT."],
    ['declined', { closedAt: '2026-10-03T10:00:00.000Z' }, 'Ruth chose not to share an address.'],
    ['cancelled', { closedAt: '2026-10-03T10:00:00.000Z' }, 'This request was cancelled, so its link no longer works.'],
    ['expired', {}, 'The link expired before Ruth answered. A new request makes a new link.']
  ] as const)('says a request %s, with no address', async (state, extra, message) => {
    vi.mocked(getAddressRequest).mockResolvedValue(request({ state, ...extra }));
    await expect(run({ requestId: ` ${REQUEST_ID} ` })).resolves.toEqual({
      requestId: REQUEST_ID,
      status: state,
      recipientName: 'Ruth',
      expiresAt: '2026-10-09T14:00:00.000Z',
      message
    });
    expect(getAddressRequest).toHaveBeenLastCalledWith({ userId: 'auth0|sender', requestId: REQUEST_ID });
  });

  it("returns an answered request's address as a preview's recipient", async () => {
    vi.mocked(getAddressRequest).mockResolvedValue(request({ state: 'answered', address: ADDRESS, closedAt: '2026-10-03T10:00:00.000Z' }));
    await expect(run({ requestId: REQUEST_ID })).resolves.toEqual({
      requestId: REQUEST_ID,
      status: 'answered',
      recipientName: 'Ruth',
      expiresAt: '2026-10-09T14:00:00.000Z',
      recipient: ADDRESS,
      message: 'Ruth gave their address, so the mail can be previewed with it now.'
    });
  });

  it("refuses a request the account doesn't have, without asking for an empty id", async () => {
    vi.mocked(getAddressRequest).mockResolvedValue(null);
    await expect(refusal(run({ requestId: REQUEST_ID }))).resolves.toEqual({
      code: 'REQUEST_NOT_FOUND',
      message: "That address request wasn't found on this account. request_address makes a new one."
    });
    vi.mocked(getAddressRequest).mockClear();
    await expect(refusal(run({ requestId: '  ' }))).resolves.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    expect(getAddressRequest).not.toHaveBeenCalled();
  });

  it('refuses while address requests are off', async () => {
    vi.stubEnv('LETTER_IRL_ADDRESS_REQUESTS_ENABLED', 'false');
    await expect(refusal(run({ requestId: REQUEST_ID }))).resolves.toMatchObject({ code: 'ADDRESS_REQUESTS_OFF' });
    expect(getAddressRequest).not.toHaveBeenCalled();
  });
});

describe('cancel_address_request (#604)', () => {
  const run = (input: Record<string, unknown>) => cancelAddressRequestTool.handler(input as never, context());

  it('closes a waiting request: its link stops working', async () => {
    vi.mocked(cancelAddressRequest).mockResolvedValue({ ok: true, request: request({ state: 'cancelled' }), alreadyClosed: false });
    await expect(run({ requestId: REQUEST_ID })).resolves.toEqual({
      requestId: REQUEST_ID,
      status: 'cancelled',
      alreadyClosed: false,
      message: 'Cancelled: the link for Ruth no longer works.'
    });
    expect(cancelAddressRequest).toHaveBeenCalledWith({ userId: 'auth0|sender', requestId: REQUEST_ID });
  });

  it('leaves a closed request as it is, and says what it is', async () => {
    vi.mocked(cancelAddressRequest).mockResolvedValue({
      ok: true,
      request: request({ state: 'answered', address: ADDRESS }),
      alreadyClosed: true
    });
    await expect(run({ requestId: REQUEST_ID })).resolves.toEqual({
      requestId: REQUEST_ID,
      status: 'answered',
      alreadyClosed: true,
      message: 'Nothing changed. Ruth gave their address, so the mail can be previewed with it now.'
    });
  });

  it("refuses a request the account doesn't have", async () => {
    vi.mocked(cancelAddressRequest).mockResolvedValue({ ok: false, refusal: 'not_found' });
    await expect(refusal(run({ requestId: REQUEST_ID }))).resolves.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
  });

  it('is destructive, as its link cannot be restored, and idempotent', () => {
    expect(cancelAddressRequestTool.meta).toMatchObject({ destructiveHint: true, idempotentHint: true, readOnlyHint: false });
  });
});

describe('the shared rules (#604)', () => {
  it('builds the link on the website, without a trailing slash', () => {
    expect(addressRequestUrl(TOKEN, { LETTER_IRL_WEBSITE_BASE_URL: 'https://letterirl.example/' } as never)).toBe(
      `https://letterirl.example/address#${TOKEN}`
    );
  });

  it('takes first names with marks, hyphens, apostrophes and full stops', () => {
    for (const name of ['Pat', 'Jos\u00E9', "D'Arcy", 'Anne-Marie', 'Mary Ann', 'Jean-Luc', 'J.', 'J.R.', 'J.R', 'A.B', 'J. R.', 'J.-P.', 'O\u2019Neil', 'Zo\u00EB']) {
      expect(senderFirstNameOf(name), name).toBe(name);
    }
    expect(senderFirstNameOf(undefined)).toBeNull();
    expect(senderFirstNameOf('')).toBeNull();
  });

  it("reads a saved name's first word only when it reads as a first name", () => {
    expect(firstNameFromSaved('Pat Sender')).toBe('Pat');
    expect(firstNameFromSaved('  Jos\u00E9  Garc\u00EDa ')).toBe('Jos\u00E9');
    expect(firstNameFromSaved('ACME, Inc.')).toBeNull();
    for (const titled of ['Dr. Pat Sender', 'Mrs. Ruth Example', 'Mr Pat Sender', 'MS. PAT', 'The Smiths']) {
      expect(firstNameFromSaved(titled), titled).toBeNull();
    }
    expect(firstNameFromSaved(undefined)).toBeNull();
  });

  it('names when a link stops working as New York has it, with plain spaces', () => {
    expect(linkExpiry('2026-10-10T02:00:00.000Z')).toBe('October 9 at 10:00 PM EDT');
    expect(linkExpiry('2026-12-01T15:30:00.000Z')).toBe('December 1 at 10:30 AM EST');
  });

  it('keeps a recipient name of up to 100 characters, counted as a reader does', () => {
    expect(recipientNameOf('\u{1F600}'.repeat(100))).toBe('\u{1F600}'.repeat(100));
    expect(() => recipientNameOf('\u{1F600}'.repeat(101))).toThrow(AddressRequestRefusedError);
  });
});

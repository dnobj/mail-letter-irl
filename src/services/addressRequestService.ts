/**
 * Address requests (#604, concept 10 in docs/letter-creator-vision.md).
 *
 * A sender who lacks someone's address makes a request. Its link carries a
 * token this server keeps only as its SHA-256 (migration 049), so the link is
 * shown once, in request_address's answer. The person the sender shares it
 * with gives a U.S. address, or declines, on the website, signed out. Letter
 * IRL never contacts them itself.
 *
 * A request is answered or declined once: one UPDATE that requires 'waiting'
 * and an unexpired link, so of two answers at once one finds the row waiting
 * and the other finds it closed. Expired is read, not stored: a waiting
 * request past expires_at.
 */

import { createHash, randomBytes } from 'node:crypto';
import { query, transaction } from '../db/index.js';
import {
  addressRequestDailyCap,
  addressRequestLinkDays,
  addressRequestWaitingCap
} from '../config/addressRequests.js';

export type AddressRequestState = 'waiting' | 'answered' | 'declined' | 'cancelled' | 'expired';

/** An address as the preview tools take a recipient's (src/zodSchemas.ts addressZ). */
export interface RequestedAddress {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: 'US';
}

/** An address as the recipient gives it: the name is theirs to leave out. */
export type GivenAddress = Omit<RequestedAddress, 'name'> & { name?: string };

export interface AddressRequest {
  requestId: string;
  state: AddressRequestState;
  recipientName: string;
  senderFirstName: string;
  createdAt: string;
  expiresAt: string;
  /** When it was answered, declined or cancelled; null while waiting or expired. */
  closedAt: string | null;
  /** The address given, while the request is answered. */
  address: RequestedAddress | null;
}

/** What the link's page may show: the sender's first name and the state, nothing else. */
export interface AddressRequestPage {
  state: AddressRequestState;
  senderFirstName: string;
  expiresAt: string;
}

/** 18 random bytes: 144 bits, written as 24 characters of base64url. */
const TOKEN_BYTES = 18;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24}$/;

/** A new link token. Only its hash is stored. */
export function mintAddressRequestToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The SHA-256 a token is kept as, or null for anything not shaped like a
 * token, which then matches no request without a query.
 */
export function addressRequestTokenHash(token: unknown): Buffer | null {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  return createHash('sha256').update(token, 'utf8').digest();
}

const REQUEST_COLUMNS = `request_id, status, recipient_name, sender_first_name, address,
       created_at, expires_at, closed_at,
       (status = 'waiting' AND expires_at <= NOW()) AS expired`;

interface AddressRequestRow {
  request_id: string;
  status: Exclude<AddressRequestState, 'expired'>;
  recipient_name: string;
  sender_first_name: string;
  address: RequestedAddress | null;
  created_at: Date;
  expires_at: Date;
  closed_at: Date | null;
  expired: boolean;
}

function requestOf(row: AddressRequestRow): AddressRequest {
  const state: AddressRequestState = row.expired ? 'expired' : row.status;
  return {
    requestId: row.request_id,
    state,
    recipientName: row.recipient_name,
    senderFirstName: row.sender_first_name,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    address: state === 'answered' ? row.address : null
  };
}

export type CreateAddressRequestResult =
  | { ok: true; request: AddressRequest; token: string }
  | { ok: false; refusal: 'waiting_cap' | 'daily_cap'; cap: number }
  | { ok: false; refusal: 'account_closed' };

/**
 * Makes a request for the account, within its caps: so many waiting at once,
 * and so many in 24 hours. The account row is locked first, so two requests
 * at once cannot both pass a cap with one place left, and an erasure that
 * commits while this waits for the lock leaves nothing to ask for: erasure
 * locks the same row (#605 review round 1, the #449 race).
 */
export async function createAddressRequest(params: {
  userId: string;
  recipientName: string;
  senderFirstName: string;
}): Promise<CreateAddressRequestResult> {
  const waitingCap = addressRequestWaitingCap();
  const dailyCap = addressRequestDailyCap();
  const linkDays = addressRequestLinkDays();
  return transaction(async (client) => {
    const account = await client.query<{ erased_at: Date | null }>(
      'SELECT erased_at FROM users WHERE user_id = $1 FOR UPDATE',
      [params.userId]
    );
    if (!account.rows[0] || account.rows[0].erased_at) return { ok: false, refusal: 'account_closed' } as const;
    const counts = await client.query<{ waiting: number; today: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'waiting' AND expires_at > NOW())::int AS waiting,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS today
         FROM address_requests
        WHERE user_id = $1`,
      [params.userId]
    );
    const { waiting, today } = counts.rows[0] ?? { waiting: 0, today: 0 };
    if (waiting >= waitingCap) return { ok: false, refusal: 'waiting_cap', cap: waitingCap } as const;
    if (today >= dailyCap) return { ok: false, refusal: 'daily_cap', cap: dailyCap } as const;

    const token = mintAddressRequestToken();
    const inserted = await client.query<AddressRequestRow>(
      `INSERT INTO address_requests (user_id, token_hash, recipient_name, sender_first_name, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(days => $5::int))
       RETURNING ${REQUEST_COLUMNS}`,
      [params.userId, addressRequestTokenHash(token), params.recipientName, params.senderFirstName, linkDays]
    );
    return { ok: true, request: requestOf(inserted.rows[0]), token } as const;
  });
}

/** One of the account's requests, or null when it has none by that id. */
export async function getAddressRequest(params: {
  userId: string;
  requestId: string;
}): Promise<AddressRequest | null> {
  if (!isUuid(params.requestId)) return null;
  const result = await query<AddressRequestRow>(
    `SELECT ${REQUEST_COLUMNS}
       FROM address_requests
      WHERE request_id = $1::uuid AND user_id = $2`,
    [params.requestId, params.userId]
  );
  return result.rows[0] ? requestOf(result.rows[0]) : null;
}

export type CancelAddressRequestResult =
  | { ok: true; request: AddressRequest; alreadyClosed: boolean }
  | { ok: false; refusal: 'not_found' };

/**
 * Closes a waiting request: its link stops working. A request already
 * answered, declined, cancelled or expired is left as it is and said to be.
 */
export async function cancelAddressRequest(params: {
  userId: string;
  requestId: string;
}): Promise<CancelAddressRequestResult> {
  if (!isUuid(params.requestId)) return { ok: false, refusal: 'not_found' };
  const cancelled = await query<AddressRequestRow>(
    `UPDATE address_requests
        SET status = 'cancelled', closed_at = NOW()
      WHERE request_id = $1::uuid AND user_id = $2
        AND status = 'waiting' AND expires_at > NOW()
      RETURNING ${REQUEST_COLUMNS}`,
    [params.requestId, params.userId]
  );
  if (cancelled.rows[0]) return { ok: true, request: requestOf(cancelled.rows[0]), alreadyClosed: false };
  const request = await getAddressRequest(params);
  return request ? { ok: true, request, alreadyClosed: true } : { ok: false, refusal: 'not_found' };
}

/**
 * What the link's page may show, by its token: the sender's first name and
 * the state. Null for a token that matches no request.
 */
export async function readAddressRequestPage(token: unknown): Promise<AddressRequestPage | null> {
  const hash = addressRequestTokenHash(token);
  if (!hash) return null;
  const result = await query<AddressRequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM address_requests WHERE token_hash = $1`,
    [hash]
  );
  const row = result.rows[0];
  if (!row) return null;
  const request = requestOf(row);
  return { state: request.state, senderFirstName: request.senderFirstName, expiresAt: request.expiresAt };
}

export type CloseByTokenResult =
  | { ok: true }
  | { ok: false; refusal: 'not_found' | Exclude<AddressRequestState, 'waiting'> };

/**
 * Closes a request by its link: answered with the address given (already
 * checked by the caller), or declined. Once only: the UPDATE requires a
 * waiting, unexpired request, and a request it does not change is said to be
 * in the state it is in.
 */
async function closeByToken(
  token: unknown,
  closing: { status: 'answered'; address: GivenAddress } | { status: 'declined' }
): Promise<CloseByTokenResult> {
  const hash = addressRequestTokenHash(token);
  if (!hash) return { ok: false, refusal: 'not_found' };
  const { name, ...rest } = closing.status === 'answered' ? closing.address : { name: undefined };
  const address = closing.status === 'answered' ? JSON.stringify(rest) : null;
  // The name the recipient gave, else the sender's for them: the envelope's.
  const closed = await query<{ request_id: string }>(
    `UPDATE address_requests
        SET status = $2,
            address = $3::jsonb || jsonb_build_object('name', COALESCE($4::text, recipient_name)),
            closed_at = NOW()
      WHERE token_hash = $1 AND status = 'waiting' AND expires_at > NOW()
      RETURNING request_id`,
    [hash, closing.status, address, name ?? null]
  );
  if (closed.rows[0]) return { ok: true };
  const page = await readAddressRequestPage(token);
  if (!page) return { ok: false, refusal: 'not_found' };
  // Still waiting here means it expired between the two statements' clocks.
  return { ok: false, refusal: page.state === 'waiting' ? 'expired' : page.state };
}

/**
 * The recipient gives their address, checked by the caller. Without a name of
 * their own, the envelope carries the one the sender gave.
 */
export function answerAddressRequest(token: unknown, address: GivenAddress): Promise<CloseByTokenResult> {
  return closeByToken(token, { status: 'answered', address });
}

/** The recipient declines. */
export function declineAddressRequest(token: unknown): Promise<CloseByTokenResult> {
  return closeByToken(token, { status: 'declined' });
}

/**
 * Deletes requests, and any address given with them, `days` after they close:
 * from closed_at once answered, declined or cancelled, and from expires_at
 * for one still waiting, which keeps no closed_at. Returns how many went.
 * Maintenance runs it every pass (#604).
 */
export async function purgeClosedAddressRequests(days: number): Promise<number> {
  const result = await query(
    `DELETE FROM address_requests
      WHERE COALESCE(closed_at, expires_at) < NOW() - make_interval(days => $1::int)`,
    [days]
  );
  return result.rowCount ?? 0;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

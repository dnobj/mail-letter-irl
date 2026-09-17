/**
 * The same mail sent twice (#412).
 *
 * Each draft is sent at most once, but two drafts can hold the same mail. On
 * ChatGPT web a preview call approved with "Allow once" can run late, after
 * the preview card has made its own draft (#411). If the person sends the
 * card's draft and then confirms the model's draft in the chat, two identical
 * letters are printed and paid for.
 *
 * So before a send from balance, and before a new Pay & Send checkout, the
 * server looks for the same mail from the same account in the last 24 hours
 * (a draft's whole lifetime). A match refuses the call unless the caller says
 * the person asked for another copy.
 *
 * "The same mail", as agreed with the owner on 2026-09-17:
 * - the same kind (letter or postcard) and, for a letter, the same layout;
 *   for a postcard, the same size;
 * - the same recipient and the same return address;
 * - the same words: body and sign-off, or the postcard message;
 * - the same picture, compared by the processed image the server prints,
 *   because the two drafts in the #412 sequence get one picture through
 *   different links.
 * Capitalization and runs of whitespace do not count.
 *
 * "Already sent" means mail created from the account (sent from balance or
 * from a paid Pay & Send order) unless it failed or was cancelled, a Pay &
 * Send order paid but not yet turned into mail, or a checkout still open.
 *
 * Every query here carries a `duplicate mail check` comment, which the unit
 * test doubles key on. letters.created_at and orders.created_at are TIMESTAMP
 * columns holding UTC wall time, so the window is computed from
 * `NOW() AT TIME ZONE 'UTC'`, as in betaSpendLimits.ts. No try/catch: a query
 * failure propagates, which inside the send transaction rolls it back.
 */

import type pg from 'pg';

export const DUPLICATE_MAIL_WINDOW_HOURS = 24;
export const DUPLICATE_MAIL_ERROR_CODE = 'DUPLICATE_RECENT_MAIL';
/** Widget-only details on the refusal (see registerTools.ts). */
export const DUPLICATE_MAIL_META_KEY = 'letterirl/duplicateMail';
/** Every refusal message starts with this, so a card can recognise one without the details. */
export const DUPLICATE_MAIL_MESSAGE_PREFIX = 'Possible duplicate:';

export type DuplicateMailType = 'letter' | 'postcard';
export type DuplicateMailKind = 'sent' | 'paid' | 'checkout_open';
export type DuplicateMailTool = 'send_letter' | 'send_postcard' | 'create_mail_checkout';

/** The narrow query shape both a transaction client and the pool's query() satisfy. */
export interface DuplicateMailQueryable {
  query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>>;
}

/** What two pieces of mail are compared on. Images are MD5 hex digests of the printed image data. */
export interface ComparableMail {
  mailType: DuplicateMailType;
  layoutType?: string | null;
  postcardSize?: string | null;
  sender: unknown;
  recipient: unknown;
  bodyText?: string | null;
  signOff?: string | null;
  headerImageMd5: string;
  inlineImageMd5: string;
  frontImageMd5: string;
}

export interface DuplicateMail {
  kind: DuplicateMailKind;
  mailType: DuplicateMailType;
  recipientName: string;
  ageSeconds: number;
}

export class DuplicateMailError extends Error {
  readonly code = DUPLICATE_MAIL_ERROR_CODE;
  readonly diagnosticClass = DUPLICATE_MAIL_ERROR_CODE;

  constructor(
    readonly duplicate: DuplicateMail,
    message = duplicateMailMessage(duplicate, duplicate.mailType === 'postcard' ? 'send_postcard' : 'send_letter')
  ) {
    super(message);
    this.name = 'DuplicateMailError';
  }
}

export function isDuplicateMailError(error: unknown): error is DuplicateMailError {
  return error instanceof DuplicateMailError;
}

/** Lower case, one space for any run of whitespace, no outer whitespace. */
export function normalizeMailText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The preview tools' own rule (normalizeCountryToUS in tools/letterHelpers.ts),
 * restated so this service does not import the tool layer. A missing country
 * and the usual spellings of the United States all mean US.
 */
function countryCode(value: unknown): string {
  const country = typeof value === 'string' ? value.toUpperCase().trim() : '';
  if (!country || ['US', 'USA', 'UNITED STATES', 'U.S.', 'U.S.A.'].includes(country)) return 'US';
  return country;
}

function addressParts(value: unknown): string[] {
  const address = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return [
    address.name,
    address.addressLine1,
    address.addressLine2,
    address.city,
    address.state,
    address.postalCode,
    countryCode(address.country)
  ].map(normalizeMailText);
}

/** Two pieces of mail are the same when their fingerprints are equal. */
export function mailFingerprint(mail: ComparableMail): string {
  const postcard = mail.mailType === 'postcard';
  return JSON.stringify({
    mailType: mail.mailType,
    format: postcard
      ? normalizeMailText(mail.postcardSize || '6x9')
      : normalizeMailText(mail.layoutType || 'text_only'),
    recipient: addressParts(mail.recipient),
    sender: addressParts(mail.sender),
    words: postcard
      ? [normalizeMailText(mail.bodyText)]
      : [normalizeMailText(mail.bodyText), normalizeMailText(mail.signOff)],
    images: postcard ? [mail.frontImageMd5] : [mail.headerImageMd5, mail.inlineImageMd5]
  });
}

export function describeMailAge(ageSeconds: number): string {
  const minutes = Math.floor(Math.max(0, ageSeconds) / 60);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/** Written for the model: what happened, and what it may do next. */
export function duplicateMailMessage(duplicate: DuplicateMail, tool: DuplicateMailTool): string {
  const noun = duplicate.mailType;
  const to = duplicate.recipientName ? ` to ${duplicate.recipientName}` : '';
  const when = describeMailAge(duplicate.ageSeconds);
  const what =
    duplicate.kind === 'sent'
      ? `This same ${noun}${to} was already sent from this account ${when}.`
      : duplicate.kind === 'paid'
        ? `This same ${noun}${to} was already paid for with Pay & Send ${when}, and it will be mailed.`
        : `A Pay & Send checkout for this same ${noun}${to} was started ${when} and is still open. If it is paid, that copy will be mailed too.`;
  const nothing = tool === 'create_mail_checkout' ? 'No checkout was created' : 'Nothing was sent or charged';
  const retry =
    tool === 'create_mail_checkout'
      ? 'call create_mail_checkout again with the same draftId and sendAnotherCopy: true'
      : `call ${tool} again with the same draftId, confirm: true and sendAnotherCopy: true`;
  return (
    `${DUPLICATE_MAIL_MESSAGE_PREFIX} ${what} ${nothing} this time. ` +
    `Ask the user whether they want another copy. Only if they do, ${retry}.`
  );
}

interface MailRow {
  mail_type: string | null;
  layout_type: string | null;
  postcard_size: string | null;
  sender: unknown;
  recipient: unknown;
  body_text: string | null;
  sign_off: string | null;
  header_image_md5: string;
  inline_image_md5: string;
  front_image_md5: string;
}

interface DatedMailRow extends MailRow {
  age_seconds: number | string;
}

function comparable(row: MailRow): ComparableMail {
  return {
    mailType: row.mail_type === 'postcard' ? 'postcard' : 'letter',
    layoutType: row.layout_type,
    postcardSize: row.postcard_size,
    sender: row.sender,
    recipient: row.recipient,
    bodyText: row.body_text,
    signOff: row.sign_off,
    headerImageMd5: row.header_image_md5,
    inlineImageMd5: row.inline_image_md5,
    frontImageMd5: row.front_image_md5
  };
}

function recipientName(value: unknown): string {
  const name = value && typeof value === 'object' ? (value as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * The draft as it would be printed, or null when the draft is not this
 * user's. The image digests are computed by PostgreSQL, like those of the mail
 * it is compared with.
 */
export async function loadComparableDraft(
  db: DuplicateMailQueryable,
  draftId: string,
  userId: string
): Promise<ComparableMail | null> {
  const result = await db.query<MailRow>(
    `/* duplicate mail check: draft */
     SELECT mail_type::text AS mail_type, layout_type, postcard_size, sender, recipient,
            body_text, sign_off,
            md5(COALESCE(header_image_data, '')) AS header_image_md5,
            md5(COALESCE(inline_image_data, '')) AS inline_image_md5,
            md5(COALESCE(front_image_data, '')) AS front_image_md5
     FROM letter_drafts
     WHERE draft_id = $1::uuid AND user_id = $2`,
    [draftId, userId]
  );
  const row = result.rows?.[0];
  return row ? comparable(row) : null;
}

/**
 * The most significant recent match for `mail`, or null: mail created beats a
 * paid order, which beats an open checkout; within a kind, the newest wins.
 * `draftId` and `excludeLetterId` are the send being checked, which must not
 * match itself.
 */
export async function findRecentDuplicateMail(
  db: DuplicateMailQueryable,
  params: {
    userId: string;
    draftId: string;
    mail: ComparableMail;
    excludeLetterId?: string;
  }
): Promise<DuplicateMail | null> {
  const fingerprint = mailFingerprint(params.mail);
  const mailType = params.mail.mailType;

  const letters = await db.query<DatedMailRow>(
    `/* duplicate mail check: letters */
     SELECT l.mail_type::text AS mail_type,
            l.content->>'layoutType' AS layout_type,
            l.content->>'postcardSize' AS postcard_size,
            l.content->'sender' AS sender,
            l.recipient,
            CASE WHEN l.mail_type::text = 'postcard' THEN l.content->>'message'
                 ELSE l.content->>'bodyText' END AS body_text,
            l.content->>'signOff' AS sign_off,
            md5(COALESCE(l.content->>'headerImageData', '')) AS header_image_md5,
            md5(COALESCE(l.content->>'inlineImageData', '')) AS inline_image_md5,
            md5(COALESCE(l.content->>'frontImageData', '')) AS front_image_md5,
            EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - l.created_at))::float8 AS age_seconds
     FROM letters l
     WHERE l.user_id = $1
       AND l.mail_type::text = $2
       AND l.letter_id <> $3
       AND l.status NOT IN ('failed', 'cancelled')
       AND l.redacted_at IS NULL
       AND l.created_at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '${DUPLICATE_MAIL_WINDOW_HOURS} hours'
     ORDER BY l.created_at DESC`,
    [params.userId, mailType, params.excludeLetterId ?? '']
  );

  const orders = await db.query<DatedMailRow & { status: string }>(
    `/* duplicate mail check: orders */
     SELECT o.status,
            d.mail_type::text AS mail_type, d.layout_type, d.postcard_size, d.sender, d.recipient,
            d.body_text, d.sign_off,
            md5(COALESCE(d.header_image_data, '')) AS header_image_md5,
            md5(COALESCE(d.inline_image_data, '')) AS inline_image_md5,
            md5(COALESCE(d.front_image_data, '')) AS front_image_md5,
            EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - o.created_at))::float8 AS age_seconds
     FROM orders o
     JOIN letter_drafts d ON d.draft_id = o.draft_id
     WHERE o.user_id = $1
       AND o.order_type = 'jit_mail'
       AND o.draft_id <> $2::uuid
       AND o.letter_id IS NULL
       AND d.mail_type::text = $3
       AND d.redacted_at IS NULL
       AND o.created_at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '${DUPLICATE_MAIL_WINDOW_HOURS} hours'
       AND (
         o.status IN ('paid', 'fulfillment_pending')
         OR (o.status = 'checkout_pending'
             AND (o.checkout_expires_at IS NULL OR o.checkout_expires_at > NOW()))
       )
     ORDER BY o.created_at DESC`,
    [params.userId, params.draftId, mailType]
  );

  const found = (kind: DuplicateMailKind, row: DatedMailRow): DuplicateMail => ({
    kind,
    mailType,
    recipientName: recipientName(row.recipient),
    ageSeconds: Number(row.age_seconds) || 0
  });

  const sent = (letters.rows ?? []).find(row => mailFingerprint(comparable(row)) === fingerprint);
  if (sent) return found('sent', sent);

  const matchingOrders = (orders.rows ?? []).filter(row => mailFingerprint(comparable(row)) === fingerprint);
  const paid = matchingOrders.find(row => row.status !== 'checkout_pending');
  if (paid) return found('paid', paid);
  const open = matchingOrders[0];
  return open ? found('checkout_open', open) : null;
}

/**
 * Whether the draft already has a Pay & Send order in one of `statuses`. A
 * new checkout for such a draft reuses that order, so nothing new is bought.
 */
export async function draftHasActiveOrder(
  db: DuplicateMailQueryable,
  params: { draftId: string; userId: string; statuses: readonly string[] }
): Promise<boolean> {
  const result = await db.query<{ order_id: string }>(
    `/* duplicate mail check: active order */
     SELECT order_id FROM orders
     WHERE draft_id = $1::uuid AND user_id = $2 AND order_type = 'jit_mail'
       AND status = ANY($3::varchar[])
     LIMIT 1`,
    [params.draftId, params.userId, params.statuses]
  );
  return Boolean(result.rows?.[0]);
}

/**
 * Refuses a send or a new checkout for mail that already went out, was paid
 * for, or is awaiting payment. A draft that is not this user's is left to the
 * caller's own ownership check.
 */
export async function assertNoRecentDuplicateMail(
  db: DuplicateMailQueryable,
  params: { userId: string; draftId: string; excludeLetterId?: string }
): Promise<void> {
  const mail = await loadComparableDraft(db, params.draftId, params.userId);
  if (!mail) return;
  const duplicate = await findRecentDuplicateMail(db, { ...params, mail });
  if (duplicate) throw new DuplicateMailError(duplicate);
}

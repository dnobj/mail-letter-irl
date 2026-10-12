/**
 * The version of what a draft prints and how it travels (#695): the person sends
 * what they saw, or nothing.
 *
 * A send carried only the draft's id, so a draft changed after the person saw it
 * (by set_letter_words, set_stationery, set_arrival_date and the rest, from the
 * chat or the card) was mailed as changed. Every preview, every in-place edit,
 * get_draft_status and the confirmation page now give the version of the draft
 * they show; the send and the Pay & Send checkout take it back and compare it,
 * under the draft's lock, with the draft as it is (DRAFT_CHANGED_SINCE_SHOWN).
 *
 * It is a hash over every column that prints or decides delivery, read from the
 * stored row: the words and pages; the stationery, its design included; the
 * signature, the header, inline and front pictures (by their hash); the mail
 * service and the dates; a postcard's size and front; both addresses; the
 * layout; whether it is a gift letter, whose card page prints; and the renderer
 * that draws it. Not the preview's HTML, which is drawn from these, nor the
 * price. Always computed from the row as stored (jsonb returns its keys in one
 * order, dates come back as 'YYYY-MM-DD' strings), never from a tool's
 * arguments, so every reader agrees.
 */

import { createHash } from 'node:crypto';

/** The pictures the version reads by their hash. */
const PICTURES = ['signature_image', 'header_image_data', 'inline_image_data', 'front_image_data'] as const;

/** Everything else it reads as stored. */
const PLAIN = [
  'mail_type', 'sender', 'recipient', 'body_text', 'sign_off', 'pages', 'layout_type', 'stationery',
  'postcard_size', 'postcard_front', 'mail_service', 'arrive_by', 'mail_on', 'is_gift_send', 'renderer_version'
] as const;

/**
 * A picture's hash computed by the database, exactly as pictureHash computes it
 * here (the SHA-256 of its text, in hex), so a reader need not fetch megabytes
 * of image data to know the version.
 */
function pictureHashColumn(alias: string, column: string): string {
  const value = `${alias}${column}`;
  return `CASE WHEN ${value} IS NULL OR ${value} = '' THEN NULL ELSE encode(sha256(convert_to(${value}, 'UTF8')), 'hex') END AS ${column}_hash`;
}

/** The columns of letter_drafts the version is over, for a query's select list, with an optional table alias ('d.'). */
export function contentVersionColumns(alias = ''): string {
  return [...PLAIN.map(column => `${alias}${column}`), ...PICTURES.map(column => pictureHashColumn(alias, column))].join(', ');
}

export const CONTENT_VERSION_COLUMNS = contentVersionColumns();

/** A draft's row, as far as the version reads it: its pictures as data (SELECT *) or as hashes (contentVersionColumns). */
export interface ContentVersionRow {
  mail_type?: string | null;
  sender?: unknown;
  recipient?: unknown;
  body_text?: string | null;
  sign_off?: string | null;
  pages?: number | string | null;
  layout_type?: string | null;
  stationery?: unknown;
  signature_image?: string | null;
  header_image_data?: string | null;
  inline_image_data?: string | null;
  front_image_data?: string | null;
  signature_image_hash?: string | null;
  header_image_data_hash?: string | null;
  inline_image_data_hash?: string | null;
  front_image_data_hash?: string | null;
  postcard_size?: string | null;
  postcard_front?: unknown;
  mail_service?: string | null;
  arrive_by?: string | Date | null;
  mail_on?: string | Date | null;
  is_gift_send?: boolean | null;
  renderer_version?: string | null;
}

/** A picture's own hash: the version need not carry megabytes, only notice a change. */
function pictureHash(data: string | null | undefined): string | null {
  return data ? createHash('sha256').update(data, 'utf8').digest('hex') : null;
}

/** The picture's hash from the database when it gave one, else from the data. */
function pictureOf(row: ContentVersionRow, column: (typeof PICTURES)[number]): string | null {
  const hashed = row[`${column}_hash`];
  return hashed !== undefined ? hashed ?? null : pictureHash(row[column]);
}

/** A date as the row gives it: 'YYYY-MM-DD' (the DATE parser), whatever the driver hands back. */
function day(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** The version of a draft's content: 16 hex characters, the same for the same printed mail. */
export function contentVersionOf(row: ContentVersionRow): string {
  const fields = [
    row.mail_type ?? 'letter',
    row.sender ?? null,
    row.recipient ?? null,
    row.body_text ?? '',
    row.sign_off ?? '',
    Number(row.pages ?? 1),
    row.layout_type ?? null,
    row.stationery ?? null,
    pictureOf(row, 'signature_image'),
    pictureOf(row, 'header_image_data'),
    pictureOf(row, 'inline_image_data'),
    pictureOf(row, 'front_image_data'),
    row.postcard_size ?? null,
    row.postcard_front ?? null,
    row.mail_service ?? 'standard',
    day(row.arrive_by),
    day(row.mail_on),
    row.is_gift_send === true,
    row.renderer_version ?? null
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16);
}

/**
 * Whether a send names the version of the draft as it is now. A send that names
 * none is let through for one release, and said so in the log, while the cards and
 * the confirmation page come to send it (#695's rollout); a version that differs
 * is refused.
 */
export function contentVersionMatches(shown: unknown, row: ContentVersionRow): 'matches' | 'missing' | 'differs' {
  const given = typeof shown === 'string' ? shown.trim() : shown;
  if (given === undefined || given === null || given === '') return 'missing';
  return given === contentVersionOf(row) ? 'matches' : 'differs';
}

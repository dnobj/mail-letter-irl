/**
 * The content version (#695): one hash over what a draft prints and how it
 * travels, read from the stored row, so a send can tell whether the draft is
 * still the one the person was shown.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CONTENT_VERSION_COLUMNS,
  contentVersionColumns,
  contentVersionMatches,
  contentVersionOf,
  type ContentVersionRow
} from '../../../src/services/contentVersion.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const ROW: ContentVersionRow = {
  mail_type: 'letter',
  sender: { name: 'Sam', addressLine1: '1 Main St', city: 'Boston', provinceOrState: 'MA', postalOrZip: '02101' },
  recipient: { name: 'Alex', addressLine1: '2 Elm St', city: 'Denver', provinceOrState: 'CO', postalOrZip: '80202' },
  body_text: 'Dear Alex,\n\nHello.',
  sign_off: 'Love, Sam',
  pages: 1,
  layout_type: 'text_only',
  stationery: { theme: 'botanical', dateLine: 'October 1, 2026' },
  signature_image: 'data:image/png;base64,c2lnbmF0dXJl',
  header_image_data: null,
  inline_image_data: null,
  front_image_data: null,
  postcard_size: null,
  postcard_front: null,
  mail_service: 'standard',
  arrive_by: '2026-10-16',
  mail_on: '2026-10-06',
  is_gift_send: false,
  renderer_version: 'pdf-4'
};

describe('contentVersionOf', () => {
  it('is 16 hex characters, the same for the same row', () => {
    expect(contentVersionOf(ROW)).toMatch(/^[0-9a-f]{16}$/);
    expect(contentVersionOf({ ...ROW })).toBe(contentVersionOf(ROW));
  });

  it.each<[string, Partial<ContentVersionRow>]>([
    ['the mail type', { mail_type: 'postcard' }],
    ['the sender', { sender: { ...(ROW.sender as object), name: 'Samuel' } }],
    ['the recipient', { recipient: { ...(ROW.recipient as object), addressLine1: '3 Elm St' } }],
    ['the words', { body_text: 'Dear Alex,\n\nHello!' }],
    ['the sign-off', { sign_off: 'Yours, Sam' }],
    ['the pages', { pages: 2 }],
    ['the layout', { layout_type: 'header_image' }],
    ['the stationery', { stationery: { theme: 'classic' } }],
    ['the signature', { signature_image: 'data:image/png;base64,b3RoZXI=' }],
    ['the header picture', { header_image_data: 'data:image/png;base64,aGVhZGVy' }],
    ['the inline picture', { inline_image_data: 'data:image/png;base64,aW5saW5l' }],
    ['the front picture', { front_image_data: 'data:image/png;base64,ZnJvbnQ=' }],
    ['the postcard size', { postcard_size: '6x9' }],
    ['the postcard front', { postcard_front: { kind: 'framed' } }],
    ['the mail service', { mail_service: 'certified' }],
    ['the arrival date', { arrive_by: '2026-10-19' }],
    ['the mail date', { mail_on: '2026-10-07' }],
    ['the gift letter', { is_gift_send: true }],
    ['the renderer', { renderer_version: 'pdf-5' }]
  ])('changes with %s', (_label, change) => {
    expect(contentVersionOf({ ...ROW, ...change })).not.toBe(contentVersionOf(ROW));
  });

  it('reads a picture by its hash: the database hash and the data agree', () => {
    const { signature_image, ...rest } = ROW;
    const hashed = { ...rest, signature_image_hash: sha256(signature_image as string) };
    expect(contentVersionOf(hashed)).toBe(contentVersionOf(ROW));
  });

  it('prefers the hash the database gave, null included, over any data', () => {
    expect(contentVersionOf({ ...ROW, signature_image_hash: null })).toBe(contentVersionOf({ ...ROW, signature_image: null }));
  });

  it('takes an empty picture as none', () => {
    expect(contentVersionOf({ ...ROW, signature_image: '' })).toBe(contentVersionOf({ ...ROW, signature_image: null }));
  });

  it('reads a date the same whether the driver gave a string or a Date', () => {
    expect(contentVersionOf({ ...ROW, arrive_by: new Date('2026-10-16T00:00:00Z'), mail_on: new Date('2026-10-06T00:00:00Z') }))
      .toBe(contentVersionOf(ROW));
  });

  it('reads the defaults the columns hold: letter, one page, standard', () => {
    const bare = { ...ROW, mail_type: undefined, pages: undefined, mail_service: undefined };
    expect(contentVersionOf(bare)).toBe(contentVersionOf({ ...ROW, mail_type: 'letter', pages: 1, mail_service: 'standard' }));
    expect(contentVersionOf({ ...ROW, pages: '1' })).toBe(contentVersionOf(ROW));
  });

  it('is not changed by what it does not read, such as the preview or the price', () => {
    const row = { ...ROW, preview_html: '<p>one</p>', required_credits: 1 } as ContentVersionRow;
    const other = { ...ROW, preview_html: '<p>two</p>', required_credits: 2 } as ContentVersionRow;
    expect(contentVersionOf(row)).toBe(contentVersionOf(other));
  });
});

describe('contentVersionMatches', () => {
  const version = contentVersionOf(ROW);

  it.each([undefined, null, '', '   '])('calls %j missing', shown => {
    expect(contentVersionMatches(shown, ROW)).toBe('missing');
  });

  it('matches the version of the row as it is, spaces around it ignored', () => {
    expect(contentVersionMatches(version, ROW)).toBe('matches');
    expect(contentVersionMatches(` ${version} `, ROW)).toBe('matches');
  });

  it.each([
    ['another version', '0123456789abcdef'],
    ['a version in capitals', version.toUpperCase()],
    ['a number', 42],
    ['an object', { version }]
  ])('refuses %s', (_label, shown) => {
    expect(contentVersionMatches(shown, ROW)).toBe('differs');
  });

  it('refuses the version shown once the row has changed', () => {
    expect(contentVersionMatches(version, { ...ROW, body_text: 'Changed.' })).toBe('differs');
  });
});

describe('the columns it reads', () => {
  it('selects every plain column and only the hashes of the pictures', () => {
    const columns = contentVersionColumns('d.');
    for (const column of ['mail_type', 'sender', 'recipient', 'body_text', 'sign_off', 'pages', 'layout_type', 'stationery',
      'postcard_size', 'postcard_front', 'mail_service', 'arrive_by', 'mail_on', 'is_gift_send', 'renderer_version']) {
      expect(columns).toContain(`d.${column}`);
    }
    for (const picture of ['signature_image', 'header_image_data', 'inline_image_data', 'front_image_data']) {
      expect(columns).toContain(
        `CASE WHEN d.${picture} IS NULL OR d.${picture} = '' THEN NULL ELSE encode(sha256(convert_to(d.${picture}, 'UTF8')), 'hex') END AS ${picture}_hash`
      );
      // Never the data itself, outside its hash.
      expect(columns.replace(/CASE WHEN .*? END AS \w+/g, '')).not.toContain(`d.${picture}`);
    }
    expect(CONTENT_VERSION_COLUMNS).toBe(contentVersionColumns());
  });
});

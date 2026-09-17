/**
 * "The same mail" and the refusal that names it (#412).
 *
 * The SQL itself runs against PostgreSQL in
 * tests/integration/duplicateMail.postgres.test.ts; this file pins the
 * comparison and the wiring with a fake database.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  assertNoRecentDuplicateMail,
  type ComparableMail,
  describeMailAge,
  DUPLICATE_MAIL_ERROR_CODE,
  DUPLICATE_MAIL_MESSAGE_PREFIX,
  DuplicateMailError,
  duplicateMailMessage,
  findRecentDuplicateMail,
  isDuplicateMailError,
  loadComparableDraft,
  mailFingerprint,
  normalizeMailText
} from '../../../src/services/duplicateMailService.js';

const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

const recipient = {
  name: 'Sam Rivera',
  addressLine1: '350 5th Ave',
  addressLine2: 'Suite 8701',
  city: 'New York',
  state: 'NY',
  postalCode: '10118',
  country: 'US'
};
const sender = {
  name: 'Dee Nicholl',
  addressLine1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US'
};

function letter(overrides: Partial<ComparableMail> = {}): ComparableMail {
  return {
    mailType: 'letter',
    layoutType: 'text_only',
    postcardSize: null,
    sender: { ...sender },
    recipient: { ...recipient },
    bodyText: 'Hi Sam,\nsee you soon.',
    signOff: 'Love, Dee',
    headerImageMd5: EMPTY_MD5,
    inlineImageMd5: EMPTY_MD5,
    frontImageMd5: EMPTY_MD5,
    ...overrides
  };
}

function postcard(overrides: Partial<ComparableMail> = {}): ComparableMail {
  return letter({
    mailType: 'postcard',
    layoutType: null,
    postcardSize: '6x9',
    bodyText: 'Wish you were here.',
    signOff: null,
    frontImageMd5: 'f'.repeat(32),
    ...overrides
  });
}

const same = (a: ComparableMail, b: ComparableMail) => mailFingerprint(a) === mailFingerprint(b);

describe('normalizeMailText', () => {
  it('ignores capitalization and runs of whitespace', () => {
    expect(normalizeMailText('  Hi   SAM,\n\tsee you soon. ')).toBe('hi sam, see you soon.');
  });

  it('reads anything that is not text as empty', () => {
    expect(normalizeMailText(undefined)).toBe('');
    expect(normalizeMailText(null)).toBe('');
    expect(normalizeMailText(42)).toBe('');
  });
});

describe('mailFingerprint: what counts as the same mail', () => {
  it('matches the same letter with different capitalization and spacing', () => {
    const shouted = letter({
      recipient: { ...recipient, name: 'SAM  RIVERA', city: ' new york ' },
      sender: { ...sender, name: 'dee nicholl' },
      bodyText: 'hi sam,   see YOU soon.',
      signOff: 'LOVE, DEE'
    });
    expect(same(letter(), shouted)).toBe(true);
  });

  it('treats a missing country and the spellings of the United States alike', () => {
    const { country: _dropped, ...noCountry } = recipient;
    expect(same(letter(), letter({ recipient: noCountry }))).toBe(true);
    expect(same(letter(), letter({ recipient: { ...recipient, country: 'u.s.a.' } }))).toBe(true);
    expect(same(letter(), letter({ recipient: { ...recipient, country: 'CA' } }))).toBe(false);
  });

  it('treats an absent and an empty apartment line alike', () => {
    const { addressLine2: _dropped, ...noSuite } = recipient;
    expect(same(letter({ recipient: noSuite }), letter({ recipient: { ...noSuite, addressLine2: '' } }))).toBe(true);
  });

  it.each<[string, Partial<ComparableMail>]>([
    ['another recipient name', { recipient: { ...recipient, name: 'Sam Rivers' } }],
    ['another street', { recipient: { ...recipient, addressLine1: '351 5th Ave' } }],
    ['another suite', { recipient: { ...recipient, addressLine2: 'Suite 8702' } }],
    ['another city', { recipient: { ...recipient, city: 'Brooklyn' } }],
    ['another state', { recipient: { ...recipient, state: 'NJ' } }],
    ['another ZIP code', { recipient: { ...recipient, postalCode: '10119' } }],
    ['another return address', { sender: { ...sender, addressLine1: '2 Main St' } }],
    ['another sender name', { sender: { ...sender, name: 'D. Nicholl' } }],
    ['one changed word', { bodyText: 'Hi Sam,\nsee you later.' }],
    ['another sign-off', { signOff: 'Best, Dee' }],
    ['another layout', { layoutType: 'header_image' }],
    ['a different header image', { headerImageMd5: 'a'.repeat(32) }],
    ['a different inline image', { inlineImageMd5: 'b'.repeat(32) }]
  ])('does not match a letter with %s', (_label, change) => {
    expect(same(letter(), letter(change))).toBe(false);
  });

  it('reads a missing layout as text only', () => {
    expect(same(letter({ layoutType: null }), letter({ layoutType: 'text_only' }))).toBe(true);
  });

  it('never matches a letter with a postcard', () => {
    expect(same(letter(), letter({ mailType: 'postcard' }))).toBe(false);
  });

  it('compares a postcard on its message, size and front image, not on letter fields', () => {
    expect(same(postcard(), postcard({ signOff: 'ignored', headerImageMd5: 'c'.repeat(32), layoutType: 'x' }))).toBe(true);
    expect(same(postcard(), postcard({ bodyText: 'Wish you were HERE.  ' }))).toBe(true);
    expect(same(postcard(), postcard({ bodyText: 'Wish I were there.' }))).toBe(false);
    expect(same(postcard(), postcard({ frontImageMd5: 'e'.repeat(32) }))).toBe(false);
    expect(same(postcard(), postcard({ postcardSize: '6x11' }))).toBe(false);
    expect(same(postcard({ postcardSize: null }), postcard({ postcardSize: '6x9' }))).toBe(true);
  });
});

describe('describeMailAge', () => {
  it.each([
    [0, 'less than a minute ago'],
    [59, 'less than a minute ago'],
    [60, '1 minute ago'],
    [119, '1 minute ago'],
    [120, '2 minutes ago'],
    [59 * 60 + 59, '59 minutes ago'],
    [3600, '1 hour ago'],
    [2 * 3600, '2 hours ago'],
    [23 * 3600 + 3599, '23 hours ago'],
    [-5, 'less than a minute ago']
  ])('%i seconds reads "%s"', (seconds, text) => {
    expect(describeMailAge(seconds)).toBe(text);
  });
});

describe('duplicateMailMessage', () => {
  const sent = { kind: 'sent' as const, mailType: 'letter' as const, recipientName: 'Sam Rivera', ageSeconds: 240 };

  it('tells the model what happened and how to send another copy', () => {
    expect(duplicateMailMessage(sent, 'send_letter')).toBe(
      'Possible duplicate: This same letter to Sam Rivera was already sent from this account 4 minutes ago. ' +
        'Nothing was sent or charged this time. Ask the user whether they want another copy. ' +
        'Only if they do, call send_letter again with the same draftId, confirm: true and sendAnotherCopy: true.'
    );
  });

  it('names a paid order and an open checkout for what they are', () => {
    expect(duplicateMailMessage({ ...sent, kind: 'paid', mailType: 'postcard' }, 'send_postcard')).toContain(
      'This same postcard to Sam Rivera was already paid for with Pay & Send 4 minutes ago, and it will be mailed.'
    );
    expect(duplicateMailMessage({ ...sent, kind: 'checkout_open' }, 'send_letter')).toContain(
      'A Pay & Send checkout for this same letter to Sam Rivera was started 4 minutes ago and is still open. If it is paid, that copy will be mailed too.'
    );
  });

  it('gives the checkout tool its own retry advice', () => {
    const text = duplicateMailMessage(sent, 'create_mail_checkout');
    expect(text).toContain('No checkout was created this time.');
    expect(text).toContain('call create_mail_checkout again with the same draftId and sendAnotherCopy: true.');
    expect(text).not.toContain('confirm: true');
  });

  it('leaves the name out when the mail has none', () => {
    expect(duplicateMailMessage({ ...sent, recipientName: '' }, 'send_letter')).toContain(
      'This same letter was already sent'
    );
  });

  it('always starts with the prefix a card can recognise', () => {
    for (const kind of ['sent', 'paid', 'checkout_open'] as const) {
      for (const tool of ['send_letter', 'send_postcard', 'create_mail_checkout'] as const) {
        expect(duplicateMailMessage({ ...sent, kind }, tool).startsWith(`${DUPLICATE_MAIL_MESSAGE_PREFIX} `)).toBe(true);
      }
    }
  });
});

describe('DuplicateMailError', () => {
  it('carries the code, the class and the details', () => {
    const duplicate = { kind: 'sent' as const, mailType: 'postcard' as const, recipientName: 'Sam', ageSeconds: 0 };
    const error = new DuplicateMailError(duplicate);
    expect(error.code).toBe(DUPLICATE_MAIL_ERROR_CODE);
    expect(error.diagnosticClass).toBe(DUPLICATE_MAIL_ERROR_CODE);
    expect(error.duplicate).toBe(duplicate);
    expect(error.message).toContain('call send_postcard again');
    expect(isDuplicateMailError(error)).toBe(true);
    expect(isDuplicateMailError(Object.assign(new Error('x'), { code: DUPLICATE_MAIL_ERROR_CODE }))).toBe(false);
  });
});

/** A database double that answers only the tagged queries. */
function fakeDb(answers: { draft?: Record<string, unknown> | null; letters?: unknown[]; orders?: unknown[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('duplicate mail check: draft')) return { rows: answers.draft ? [answers.draft] : [] };
      if (sql.includes('duplicate mail check: letters')) return { rows: answers.letters ?? [] };
      if (sql.includes('duplicate mail check: orders')) return { rows: answers.orders ?? [] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    })
  };
  return { db: db as any, calls };
}

/** A row shaped like the SQL's output for `mail`. */
function row(mail: ComparableMail, extra: Record<string, unknown> = {}) {
  return {
    mail_type: mail.mailType,
    layout_type: mail.layoutType ?? null,
    postcard_size: mail.postcardSize ?? null,
    sender: mail.sender,
    recipient: mail.recipient,
    body_text: mail.bodyText ?? null,
    sign_off: mail.signOff ?? null,
    header_image_md5: mail.headerImageMd5,
    inline_image_md5: mail.inlineImageMd5,
    front_image_md5: mail.frontImageMd5,
    age_seconds: 600,
    ...extra
  };
}

describe('findRecentDuplicateMail', () => {
  const params = { userId: 'user-1', draftId: 'draft-2', mail: letter(), excludeLetterId: 'letter-2' };

  it('finds nothing when nothing matches', async () => {
    const { db } = fakeDb({
      letters: [row(letter({ bodyText: 'Something else' }))],
      orders: [row(letter({ signOff: 'Other' }), { status: 'paid' })]
    });
    await expect(findRecentDuplicateMail(db, params)).resolves.toBeNull();
  });

  it('reports sent mail with its recipient name and age', async () => {
    const { db } = fakeDb({
      letters: [row(letter({ bodyText: 'nope' })), row(letter({ recipient: { ...recipient, name: '  Sam Rivera ' } }), { age_seconds: '125.5' })]
    });
    await expect(findRecentDuplicateMail(db, params)).resolves.toEqual({
      kind: 'sent',
      mailType: 'letter',
      recipientName: 'Sam Rivera',
      ageSeconds: 125.5
    });
  });

  it('prefers sent mail over a paid order, and a paid order over an open checkout', async () => {
    const open = row(letter(), { status: 'checkout_pending', age_seconds: 30 });
    const paid = row(letter(), { status: 'fulfillment_pending', age_seconds: 90 });
    const sentRow = row(letter(), { age_seconds: 3000 });

    let db = fakeDb({ letters: [sentRow], orders: [open, paid] }).db;
    await expect(findRecentDuplicateMail(db, params)).resolves.toMatchObject({ kind: 'sent', ageSeconds: 3000 });

    db = fakeDb({ orders: [open, paid] }).db;
    await expect(findRecentDuplicateMail(db, params)).resolves.toMatchObject({ kind: 'paid', ageSeconds: 90 });

    db = fakeDb({ orders: [open, row(letter(), { status: 'paid', age_seconds: 200 })] }).db;
    await expect(findRecentDuplicateMail(db, params)).resolves.toMatchObject({ kind: 'paid', ageSeconds: 200 });

    db = fakeDb({ orders: [open] }).db;
    await expect(findRecentDuplicateMail(db, params)).resolves.toMatchObject({ kind: 'checkout_open', ageSeconds: 30 });
  });

  it('takes the first match the query returns, which is the newest', async () => {
    const { db } = fakeDb({
      letters: [row(letter(), { age_seconds: 60 }), row(letter(), { age_seconds: 7200 })]
    });
    await expect(findRecentDuplicateMail(db, params)).resolves.toMatchObject({ ageSeconds: 60 });
  });

  it('asks for the right user, mail type, draft and letter to leave out', async () => {
    const { db, calls } = fakeDb({});
    await findRecentDuplicateMail(db, { ...params, mail: postcard() });
    const letters = calls.find(call => call.sql.includes('duplicate mail check: letters'))!;
    const orders = calls.find(call => call.sql.includes('duplicate mail check: orders'))!;
    expect(letters.params).toEqual(['user-1', 'postcard', 'letter-2']);
    expect(orders.params).toEqual(['user-1', 'draft-2', 'postcard']);
  });

  it('leaves no letter out when the check is not part of a send', async () => {
    const { db, calls } = fakeDb({});
    await findRecentDuplicateMail(db, { userId: 'user-1', draftId: 'draft-2', mail: letter() });
    expect(calls.find(call => call.sql.includes('duplicate mail check: letters'))!.params[2]).toBe('');
  });

  it('keeps the window and the exclusions in the SQL', async () => {
    const { db, calls } = fakeDb({});
    await findRecentDuplicateMail(db, params);
    const [letters, orders] = [calls[0].sql, calls[1].sql];
    expect(letters).toContain("l.created_at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'");
    expect(letters).toContain("l.status NOT IN ('failed', 'cancelled')");
    expect(letters).toContain('l.letter_id <> $3');
    expect(orders).toContain("o.created_at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'");
    expect(orders).toContain('o.letter_id IS NULL');
    expect(orders).toContain('o.draft_id <> $2::uuid');
    expect(orders).toContain("o.status IN ('paid', 'fulfillment_pending')");
    expect(orders).toContain("o.status = 'checkout_pending'");
  });
});

describe('loadComparableDraft and assertNoRecentDuplicateMail', () => {
  const draftRow = row(letter());

  it('reads the draft for its owner only', async () => {
    const { db, calls } = fakeDb({ draft: draftRow });
    await expect(loadComparableDraft(db, 'draft-2', 'user-1')).resolves.toMatchObject({
      mailType: 'letter',
      bodyText: 'Hi Sam,\nsee you soon.'
    });
    expect(calls[0].params).toEqual(['draft-2', 'user-1']);
    expect(calls[0].sql).toContain('WHERE draft_id = $1::uuid AND user_id = $2');
  });

  it('checks nothing for a draft that is not the user\'s', async () => {
    const { db, calls } = fakeDb({ draft: null, letters: [draftRow] });
    await expect(assertNoRecentDuplicateMail(db, { userId: 'user-1', draftId: 'draft-2' })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('refuses mail that went out recently', async () => {
    const { db } = fakeDb({ draft: draftRow, letters: [draftRow] });
    const refusal = assertNoRecentDuplicateMail(db, { userId: 'user-1', draftId: 'draft-2', excludeLetterId: 'letter-2' });
    await expect(refusal).rejects.toBeInstanceOf(DuplicateMailError);
    await expect(refusal).rejects.toMatchObject({
      code: DUPLICATE_MAIL_ERROR_CODE,
      duplicate: { kind: 'sent', recipientName: 'Sam Rivera' }
    });
  });

  it('lets new mail through', async () => {
    const { db } = fakeDb({ draft: draftRow, letters: [row(letter({ bodyText: 'Different' }))] });
    await expect(assertNoRecentDuplicateMail(db, { userId: 'user-1', draftId: 'draft-2' })).resolves.toBeUndefined();
  });

  it('reads a postcard draft as a postcard', async () => {
    const { db } = fakeDb({ draft: row(postcard()) });
    await expect(loadComparableDraft(db, 'draft-2', 'user-1')).resolves.toMatchObject({ mailType: 'postcard' });
  });
});

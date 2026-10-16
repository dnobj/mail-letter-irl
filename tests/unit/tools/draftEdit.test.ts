/**
 * One way to refuse and to read a draft an editor changes in place (#690). The six editors'
 * refusal sentences are built from what each edit changes; these hold every sentence to the
 * words each editor said before, and the order the state is refused in. What each editor
 * does with a draft it may change is tested beside it (setStationery, setLetterWords,
 * setLetterSignature, setPostcardStyle, setArrivalDate, setMailService).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DraftRefusedError,
  draftLetter,
  draftRefuser,
  editableDraft,
  type DraftRefusal,
  type EditableDraftState
} from '../../../src/tools/draftEdit.js';
import { STATIONERY_REFUSALS } from '../../../src/tools/setStationery.js';
import { WORDS_REFUSALS } from '../../../src/tools/setLetterWords.js';
import { SIGNATURE_REFUSALS } from '../../../src/tools/setLetterSignature.js';
import { POSTCARD_STYLE_REFUSALS } from '../../../src/tools/setPostcardStyle.js';
import { ARRIVAL_DATE_REFUSALS } from '../../../src/tools/setArrivalDate.js';
import { MAIL_SERVICE_REFUSALS } from '../../../src/tools/setMailService.js';
import type { ToolContext } from '../../../src/contracts/types.js';

const DRAFT_ID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0';
const NOW = new Date('2026-10-12T12:00:00Z');

function context(): ToolContext {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { correlationId: 'c1', user: { userId: 'u1' }, logger, now: () => NOW } as unknown as ToolContext;
}

const NOT_FOUND = "That preview wasn't found. Make a new preview, then try again.";

// Each editor's sentences as it wrote them out before #690, word for word.
const BEFORE: Record<string, [Record<string, DraftRefusal>, Record<string, [string, string]>]> = {
  set_stationery: [STATIONERY_REFUSALS, {
    not_found: ['DRAFT_NOT_FOUND', NOT_FOUND],
    sent: ['DRAFT_ALREADY_SENT', "This letter has already been sent, so its stationery can't change. list_orders shows it."],
    expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take stationery themselves.'],
    checkout_pending: ['DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its stationery can't change now. Finish or let that payment lapse, or make a new preview."],
    changed: ['DRAFT_CHANGED', 'The letter changed while its page was being drawn again. Try the stationery again.']
  }],
  set_letter_words: [WORDS_REFUSALS, {
    not_found: ['DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview with the words, then try again."],
    sent: ['DRAFT_ALREADY_SENT', "This letter has already been sent, so its words can't change. list_orders shows it."],
    expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview with the words.'],
    checkout_pending: ['DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its words can't change now. Finish or let that payment lapse, or make a new preview."],
    changed: ['DRAFT_CHANGED', 'The letter changed while its page was being drawn again. Try the words again.']
  }],
  set_letter_signature: [SIGNATURE_REFUSALS, {
    not_found: ['DRAFT_NOT_FOUND', NOT_FOUND],
    sent: ['DRAFT_ALREADY_SENT', "This letter has already been sent, so its signature can't change. list_orders shows it."],
    expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take signature themselves.'],
    checkout_pending: ['DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its signature can't change now. Finish or let that payment lapse, or make a new preview."],
    changed: ['DRAFT_CHANGED', 'The letter changed while its page was being drawn again. Try the signature again.']
  }],
  set_postcard_style: [POSTCARD_STYLE_REFUSALS, {
    not_found: ['DRAFT_NOT_FOUND', NOT_FOUND],
    sent: ['DRAFT_ALREADY_SENT', "This postcard has already been sent, so its size and layout can't change. list_orders shows it."],
    expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the postcard preview takes a size and a layout itself.'],
    checkout_pending: ['DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its size and layout can't change now. Finish or let that payment lapse, or make a new preview."],
    changed: ['DRAFT_CHANGED', 'The postcard changed while it was being drawn again. Try the change again.']
  }],
  set_arrival_date: [ARRIVAL_DATE_REFUSALS, {
    not_found: ['DRAFT_NOT_FOUND', NOT_FOUND],
    sent: ['DRAFT_ALREADY_SENT', "This mail has already been sent, so its arrival date can't change. list_orders shows it."],
    expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the preview tools take arriveBy themselves.'],
    checkout_pending: ['DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its arrival date can't change now. Finish or let that payment lapse, or make a new preview."]
  }],
  set_mail_service: [MAIL_SERVICE_REFUSALS, {
    not_found: ['DRAFT_NOT_FOUND', NOT_FOUND],
    sent: ['DRAFT_ALREADY_SENT', "This letter has already been sent, so how it travels can't change. list_orders shows it."],
    expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take mailService themselves.'],
    checkout_pending: [
      'DRAFT_CHECKOUT_PENDING',
      "This preview is tied to a Pay & Send payment, so how it travels can't change now. Finish or let that payment lapse, or make a new preview."
    ],
    not_a_letter: [
      'DRAFT_NOT_A_LETTER',
      'Certified mail is for letters, and a postcard always goes as ordinary mail. Make a letter preview to send certified mail.'
    ],
    gift_send: [
      'DRAFT_IS_GIFT',
      'A gift letter does not pay for certified mail. Make a new preview with mailService certified: it is paid with Pay & Send, not by a gift letter.'
    ]
  }]
};

describe('the draft editors refuse in the words they always used (#690)', () => {
  for (const [tool, [built, before]] of Object.entries(BEFORE)) {
    it(`${tool}: every state it refuses, word for word`, () => {
      for (const [state, refusal] of Object.entries(before)) {
        expect([state, ...built[state]]).toEqual([state, ...refusal]);
      }
    });
  }
});

describe('DraftRefusedError and draftRefuser', () => {
  it('carries its code as the log class, and the sentence as its message', () => {
    const error = new DraftRefusedError('DRAFT_EXPIRED', 'This preview has expired.');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'DraftRefusedError', code: 'DRAFT_EXPIRED', diagnosticClass: 'DRAFT_EXPIRED', message: 'This preview has expired.' });
  });

  it("logs each refusal as a warning under the editor's own event, with the code as the reason", () => {
    const ctx = context();
    const error = draftRefuser('draft.words_refused', 'A change of words was refused')('WORDS_MISSING', 'Give the words.', ctx);

    expect(error).toMatchObject({ code: 'WORDS_MISSING', message: 'Give the words.' });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      { correlationId: 'c1', event: 'draft.words_refused', reason: 'WORDS_MISSING' },
      'A change of words was refused'
    );
  });
});

describe('editableDraft: the state refused before the lock, in order', () => {
  type Draft = EditableDraftState & { drawn: boolean };
  const pending: Draft = { mail_type: 'letter', status: 'pending', expires_at: new Date(NOW.getTime() + 60_000), redacted_at: null, drawn: true };

  async function read(draft: Draft | null, draftId: unknown = DRAFT_ID) {
    const reader = vi.fn(async () => draft);
    const ctx = context();
    const result = editableDraft(
      {
        draftId,
        read: reader,
        mailType: 'letter',
        wrongKind: ['DRAFT_NOT_A_LETTER', 'For letters.'],
        drawn: found => found.drawn,
        notDrawn: ['DRAFT_NOT_DRAWN', 'Not drawn.'],
        refusals: STATIONERY_REFUSALS,
        refuse: draftRefuser('draft.stationery_refused', 'A stationery change was refused')
      },
      ctx
    );
    return { result, reader, ctx };
  }

  it("reads the caller's own draft by its id, trimmed, and gives both back", async () => {
    const { result, reader } = await read(pending, `  ${DRAFT_ID}\n`);
    await expect(result).resolves.toEqual({ draftId: DRAFT_ID, draft: pending });
    expect(reader).toHaveBeenCalledWith(DRAFT_ID, 'u1');
  });

  it('refuses an id of the wrong shape as not found, without reading anything', async () => {
    for (const id of ['not-a-draft', 42, null, '']) {
      const { result, reader } = await read(pending, id);
      await expect(result).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND', message: NOT_FOUND });
      expect(reader).not.toHaveBeenCalled();
    }
  });

  it("refuses a draft that is not there, or not the caller's, as not found, and logs it", async () => {
    const { result, ctx } = await read(null);
    await expect(result).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'draft.stationery_refused', reason: 'DRAFT_NOT_FOUND' }), expect.any(String));
  });

  it('refuses the wrong kind of mail before anything about its state', async () => {
    const { result } = await read({ ...pending, mail_type: 'postcard', status: 'consumed', drawn: false });
    await expect(result).rejects.toMatchObject({ code: 'DRAFT_NOT_A_LETTER', message: 'For letters.' });
  });

  it('says sent before expired, for a sent draft past its expiry', async () => {
    const { result } = await read({ ...pending, status: 'consumed', expires_at: new Date(NOW.getTime() - 1), redacted_at: NOW });
    await expect(result).rejects.toMatchObject({ code: 'DRAFT_ALREADY_SENT' });
  });

  it('counts an expired, a cancelled, an erased or a just-expiring draft as expired', async () => {
    for (const draft of [
      { ...pending, status: 'expired' },
      { ...pending, status: 'cancelled' },
      { ...pending, redacted_at: new Date(NOW.getTime() - 1000) },
      { ...pending, expires_at: NOW },
      { ...pending, expires_at: new Date(NOW.getTime() - 1) }
    ]) {
      const { result } = await read(draft);
      await expect(result).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' });
    }
  });

  it('refuses one our renderer did not draw last of all', async () => {
    await expect((await read({ ...pending, drawn: false })).result).rejects.toMatchObject({ code: 'DRAFT_NOT_DRAWN', message: 'Not drawn.' });
    await expect((await read({ ...pending, status: 'expired', drawn: false })).result).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' });
  });
});

describe('draftLetter', () => {
  const base = {
    sender: { name: 'Pat' },
    recipient: { name: 'Sam' },
    body_text: 'Hello.',
    sign_off: null,
    layout_type: null,
    header_image_data: 'data:header',
    inline_image_data: 'data:inline',
    pages: 2,
    is_gift_send: false
  };

  it("lays a letter out with its own layout's picture only, and an empty closing for none", () => {
    expect(draftLetter(base)).toMatchObject({ layoutType: 'text_only', imageData: undefined, signOff: '', bodyText: 'Hello.', pagesBefore: 2, gift: false });
    expect(draftLetter({ ...base, layout_type: 'header_image' }).imageData).toBe('data:header');
    expect(draftLetter({ ...base, layout_type: 'inline_image', is_gift_send: true })).toMatchObject({ imageData: 'data:inline', gift: true });
    expect(draftLetter({ ...base, layout_type: 'header_image', header_image_data: null }).imageData).toBeUndefined();
  });

  it('counts one page when none is stored', () => {
    expect(draftLetter({ ...base, pages: null as unknown as number }).pagesBefore).toBe(1);
  });
});

/**
 * One way to refuse and to read a draft an editor changes in place (#690).
 *
 * The draft editors (set_arrival_date, set_mail_service, set_stationery, set_letter_words,
 * set_letter_signature, set_postcard_style) change a preview without previewing it again.
 * Each refuses in its own words but the same way: one error, whose code doubles as the
 * log's class (DraftRefusedError), the draft's state in words built from what the edit
 * changes (draftRefusals), and a warning logged under the editor's own event
 * (draftRefuser; set_arrival_date logs the draft's state itself, as it always has). The editors that draw the page again read the draft the same way first
 * (editableDraft): not found, the wrong kind of mail, sent, expired or emptied by an
 * erasure, and not drawn by our renderer, in that order, so each says why at once. The
 * lock under which the change is written checks the state again (withChangeableDraft in
 * draftService.ts).
 */

import type { Address, LetterLayoutType, ToolContext } from '../contracts/types.js';
import type { DraftRedrawRefusal } from '../services/draftService.js';
import { isDraftIdShape } from './requestSend.js';

/** A refusal the model can act on: none repeats the draft id, and the code doubles as the log's class. */
export class DraftRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DraftRefusedError';
    this.diagnosticClass = code;
  }
}

/** A refusal's code and the sentence the model reads. */
export type DraftRefusal = readonly [code: string, message: string];

/** What an edit changes, as its refusals say it. */
export interface DraftRefusalWords {
  /** The mail, as "This … has already been sent" names it. */
  mail: 'letter' | 'postcard' | 'mail';
  /** What cannot change: "its stationery", "how it travels". */
  what: string;
  /** How to start again: "Make a new preview", or "Make a new preview with the words". */
  remake?: string;
  /** What a new preview takes, after a colon when the preview has expired: "the letter previews take stationery themselves". */
  previewTakes?: string;
  /** Said after the Pay & Send sentence, when there is more to say. */
  checkoutTail?: string;
  /** What to try again when the draft changed while it was drawn again: "stationery", "change". */
  retry?: string;
}

/** The draft's state, refused in the words of what the edit changes. */
export function draftRefusals(words: DraftRefusalWords): Record<DraftRedrawRefusal, DraftRefusal> {
  const remake = words.remake ?? 'Make a new preview';
  const retry = words.retry ?? 'change';
  return {
    not_found: ['DRAFT_NOT_FOUND', `That preview wasn't found. ${remake}, then try again.`],
    sent: ['DRAFT_ALREADY_SENT', `This ${words.mail} has already been sent, so ${words.what} can't change. list_orders shows it.`],
    expired: [
      'DRAFT_EXPIRED',
      `This preview has expired. ${remake}${words.previewTakes ? `: ${words.previewTakes}` : ''}.`
    ],
    checkout_pending: [
      'DRAFT_CHECKOUT_PENDING',
      `This preview is tied to a Pay & Send payment, so ${words.what} can't change now.${words.checkoutTail ? ` ${words.checkoutTail}` : ''}`
    ],
    changed: [
      'DRAFT_CHANGED',
      words.mail === 'postcard'
        ? `The postcard changed while it was being drawn again. Try the ${retry} again.`
        : `The letter changed while its page was being drawn again. Try the ${retry} again.`
    ]
  };
}

/** Makes an editor's refusals: each logged as a warning under the editor's own event, with its code as the reason. */
export function draftRefuser(event: string, logMessage: string) {
  return (code: string, message: string, context: ToolContext): DraftRefusedError => {
    context.logger.warn({ correlationId: context.correlationId, event, reason: code }, logMessage);
    return new DraftRefusedError(code, message);
  };
}

export type DraftRefuser = ReturnType<typeof draftRefuser>;

/** What any draft an editor reads has: its kind and its state. */
export interface EditableDraftState {
  mail_type: string;
  status: string;
  expires_at: Date;
  redacted_at: Date | null;
}

/**
 * The caller's draft an editor may change, read before the lock to say at once why not:
 * not found (someone else's included), the wrong kind of mail, sent, then expired, which
 * covers one an erasure emptied, so its empty content is never laid out (#573 review
 * round 3); last, one our renderer did not draw, which cannot be drawn again.
 */
export async function editableDraft<T extends EditableDraftState>(
  options: {
    draftId: unknown;
    read: (draftId: string, userId: string) => Promise<T | null>;
    mailType: 'letter' | 'postcard';
    /** Refused when the draft is another kind of mail. */
    wrongKind: DraftRefusal;
    /** Whether our renderer drew it, as this edit draws it again. */
    drawn: (draft: T) => boolean;
    notDrawn: DraftRefusal;
    refusals: Record<DraftRedrawRefusal, DraftRefusal>;
    refuse: DraftRefuser;
  },
  context: ToolContext
): Promise<{ draftId: string; draft: T }> {
  const { refusals, refuse } = options;
  const draftId = typeof options.draftId === 'string' ? options.draftId.trim() : '';
  const draft = isDraftIdShape(draftId) ? await options.read(draftId, context.user.userId) : null;
  if (!draft) throw refuse(...refusals.not_found, context);
  if (draft.mail_type !== options.mailType) throw refuse(...options.wrongKind, context);
  if (draft.status === 'consumed') throw refuse(...refusals.sent, context);
  if (draft.status !== 'pending' || draft.redacted_at || !(new Date(draft.expires_at).getTime() > context.now().getTime())) {
    throw refuse(...refusals.expired, context);
  }
  if (!options.drawn(draft)) throw refuse(...options.notDrawn, context);
  return { draftId, draft };
}

/** What a letter editor reads of its draft (getDraftForStationery). */
export interface DraftLetterSource {
  sender: Record<string, unknown>;
  recipient: Record<string, unknown>;
  body_text: string;
  sign_off: string | null;
  layout_type: string | null;
  header_image_data: string | null;
  inline_image_data: string | null;
  pages: number;
  is_gift_send: boolean;
}

/** A letter draft's content as the editors lay it out again: its own words, addresses and picture. */
export function draftLetter(draft: DraftLetterSource) {
  const layoutType = (draft.layout_type ?? 'text_only') as LetterLayoutType;
  const imageData = layoutType === 'header_image'
    ? draft.header_image_data
    : layoutType === 'inline_image' ? draft.inline_image_data : null;
  return {
    sender: draft.sender as unknown as Address,
    recipient: draft.recipient as unknown as Address,
    bodyText: draft.body_text,
    signOff: draft.sign_off ?? '',
    layoutType,
    imageData: imageData ?? undefined,
    /** The pages its preview drew: its own, then any gift card's (#586). */
    pagesBefore: Number(draft.pages ?? 1),
    /** A gift letter pays for one page only (#579). */
    gift: draft.is_gift_send === true
  };
}

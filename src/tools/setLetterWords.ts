import type { Address, LetterLayoutType, McpToolDefinition, ToolContext } from '../contracts/types.js';
import { setLetterWordsInputSchema, setLetterWordsOutputSchema } from '../schemas.js';
import { letterPageLimit } from '../config/roomToWrite.js';
import { isGiftLettersEnabled } from '../config/giftLetters.js';
import { mailServiceOf } from '../config/products.js';
import type { SendEligibility } from '../services/commerceService.js';
import { getGiftBalance } from '../services/giftLetterService.js';
import { pageFit, stationeryOf, type Layout, type PageFit } from '../render/index.js';
import { getDraftForStationery, setDraftWords, type DraftRedrawRefusal } from '../services/draftService.js';
import {
  layoutLetterForPreview,
  letterOption,
  letterPayment,
  letterRunsPast,
  pageChangeSentence,
  SIGNATURE_GIFT_WORDS,
  redrawLetterPreview,
  RENDERED_LETTER_CHARACTER_CAP,
  validateCharacterLimitForLayout,
  validatePrintableLetter,
  wordsVersionOf
} from './letterHelpers.js';
import { isDraftIdShape } from './requestSend.js';

/**
 * A letter preview's words, changed without previewing it again (#586). The
 * words are checked as the letter previews check theirs (the character cap,
 * what prints, the page), laid out again in the draft's own stationery on up
 * to the pages a preview may take, and the draft is changed in place, with its
 * page drawn again and its pages and price with it, only while it waits to be
 * sent (setDraftWords). A gift letter stays on one page: it pays for one page
 * only (#579). Nothing is sent here.
 *
 * A change names the version of the words it replaces (wordsVersion): the card
 * and the chat can each change them, and neither sees the other's call (#366),
 * so a change of words its caller has not seen is refused, with the words as
 * they are now (#593 review round 1).
 *
 * Listed only while room to write is offered (src/server.ts), and refused
 * while it is not, for an app that cached the list. The letter card's Words
 * tab calls it too.
 */
export const SET_LETTER_WORDS_TOOL = 'set_letter_words';

interface SetLetterWordsInput {
  draftId: string;
  bodyText: string;
  signOff: string;
  /** The version of the words this change replaces, from the preview or the last change. */
  wordsVersion?: string;
}

export interface SetLetterWordsOutput {
  draftId: string;
  /** The preview drawn again: for the card, in _meta, never the model's (partitionToolResult). */
  previewHtml: string;
  /** A letter of more than one page: the pages it is laid out on now. */
  pages?: number;
  /** What it costs now: new words can change its pages, and so its price. */
  canSendNow: boolean;
  reasonCannotSend?: string;
  sendEligibility: SendEligibility;
  /** How full its pages are now, for the card's fit line. Card-only (_meta). */
  pageFit: PageFit;
  /** The version of the words now, for the next change of them. */
  wordsVersion: string;
  message: string;
}

/**
 * Refusals the model can act on. Like set_stationery's, none repeats the
 * draft id, and the code doubles as the log's class. Only WORDS_CHANGED gives
 * the words, as they are now: the caller's own read of them.
 */
export class WordsRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(
    readonly code:
      | 'WORDS_DISABLED'
      | 'WORDS_MISSING'
      | 'WORDS_CHANGED'
      | 'DRAFT_NOT_FOUND'
      | 'DRAFT_ALREADY_SENT'
      | 'DRAFT_EXPIRED'
      | 'DRAFT_CHECKOUT_PENDING'
      | 'DRAFT_NOT_A_LETTER'
      | 'DRAFT_NOT_DRAWN'
      | 'DRAFT_CHANGED'
      | 'GIFT_LETTER_ONE_PAGE',
    message: string
  ) {
    super(message);
    this.name = 'WordsRefusedError';
    this.diagnosticClass = code;
  }
}

const REFUSALS: Record<DraftRedrawRefusal, [WordsRefusedError['code'], string]> = {
  not_found: ['DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview with the words, then try again."],
  sent: ['DRAFT_ALREADY_SENT', "This letter has already been sent, so its words can't change. list_orders shows it."],
  expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview with the words.'],
  checkout_pending: ['DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its words can't change now."],
  // Its stationery, or its words, changed while the page was drawn again.
  changed: ['DRAFT_CHANGED', 'The letter changed while its page was being drawn again. Try the words again.']
};

const NOT_DRAWN = 'This preview was not drawn in a way that can take new words. Make a new preview with them.';

const GIFT_ONE_PAGE =
  'This letter is sent as a gift letter, which is one page, and these words run past it. ' +
  'Shorten them to fit one page, or make a new preview to send it another way.';

function refused(code: WordsRefusedError['code'], message: string, context: ToolContext): WordsRefusedError {
  context.logger.warn(
    { correlationId: context.correlationId, event: 'draft.words_refused', reason: code },
    'A change of words was refused'
  );
  return new WordsRefusedError(code, message);
}

/**
 * Why a change of words its caller has not seen was refused, with the words as
 * they are now and their version: the conversation's read of words the card
 * changed, which the model never sees (#366).
 */
function wordsChanged(given: boolean, bodyText: string, signOff: string, version: string): string {
  const why = given
    ? "Nothing was changed: the letter's words now are not the ones that wordsVersion names. The letter card can change them too."
    : 'Nothing was changed: give wordsVersion, the version of the words this change replaces, from the preview or the last change of words.';
  const words = [bodyText.trim(), signOff.trim()].filter(Boolean).join('\n\n');
  return (
    `${why} The letter's words now are below, at wordsVersion "${version}". ` +
    `Make the change to these words, then call set_letter_words again with that wordsVersion.\n\n${words}`
  );
}

/** What the tool says it did, and what changed in the letter's pages, and so its price. */
function messageFor(pages: number, pagesBefore: number, note: string, already: boolean, mailService?: string | null): string {
  // A call retried after its answer was lost changes nothing: said so (#593 review round 3).
  if (already) return 'The letter already has these words, so nothing changed. Nothing has been sent.';
  const length = pageChangeSentence(pages, pagesBefore, mailService);
  return `The letter's words are changed and its page is drawn again.${length}${note} Nothing has been sent.`;
}

/**
 * Back on one page, a letter its balance cannot pay may be one the account's
 * gift letter can (#579). Only a preview decides a gift, so say a new preview
 * would offer it, when the account has one (#593 review round 1).
 */
export async function giftLetterNote(context: ToolContext): Promise<string> {
  if (!isGiftLettersEnabled()) return '';
  try {
    const balance = await getGiftBalance(context.user.userId);
    return balance.available > 0 ? ' A new preview of it can use your gift letter.' : '';
  } catch {
    // The words are changed either way; saying nothing never fails that.
    return '';
  }
}

async function handler(input: SetLetterWordsInput, context: ToolContext): Promise<SetLetterWordsOutput> {
  const limit = letterPageLimit();
  if (limit === 1) {
    throw refused(
      'WORDS_DISABLED',
      "A letter's words can't be changed in place yet. Make a new preview with the words you want.",
      context
    );
  }
  const bodyText = typeof input.bodyText === 'string' ? input.bodyText : '';
  const signOff = typeof input.signOff === 'string' ? input.signOff : '';
  // The words in full, as a preview takes them: none would print an empty page.
  if (bodyText.trim() === '') {
    throw refused('WORDS_MISSING', "Give the letter's words in full: bodyText, and signOff.", context);
  }
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  const userId = context.user.userId;
  const draft = isDraftIdShape(draftId) ? await getDraftForStationery(draftId, userId) : null;
  if (!draft) throw refused(...REFUSALS.not_found, context);
  if (draft.mail_type !== 'letter') {
    throw refused('DRAFT_NOT_A_LETTER', "A postcard's words are its message: make a new postcard preview with them.", context);
  }
  // Read before the lock, to say why at once; setDraftWords checks again under
  // it. A draft an erasure emptied is refused as the lock refuses it.
  if (draft.status === 'consumed') throw refused(...REFUSALS.sent, context);
  if (draft.status !== 'pending' || draft.redacted_at || !(new Date(draft.expires_at).getTime() > context.now().getTime())) {
    throw refused(...REFUSALS.expired, context);
  }
  // Only a letter our renderer drew can be drawn again with new words.
  if (!draft.renderer_version) throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);

  // The words it replaces, by their version: refused, with the words as they
  // are now, unless they are the ones its caller last saw.
  const replacing = { bodyText: draft.body_text, signOff: draft.sign_off };
  const current = wordsVersionOf(replacing.bodyText, replacing.signOff);
  // As a model may copy it: with spaces or quotes round it (#593 review round 2).
  const named = typeof input.wordsVersion === 'string' ? input.wordsVersion.trim().replace(/^["']+|["']+$/g, '') : '';
  // Words the draft has already, as when a call is retried after its answer
  // was lost, are no change to anything unseen: the call goes through.
  const already = bodyText === replacing.bodyText && signOff === (replacing.signOff ?? '');
  if (named !== current && !already) {
    throw refused('WORDS_CHANGED', wordsChanged(named !== '', replacing.bodyText, replacing.signOff ?? '', current), context);
  }
  // The pages its preview drew: its own, then any gift card's.
  const pagesBefore = Number(draft.pages ?? 1);

  const sender = draft.sender as unknown as Address;
  const recipient = draft.recipient as unknown as Address;
  const layoutType = (draft.layout_type ?? 'text_only') as LetterLayoutType;
  // In the stationery it is drawn in now, as the print reads it back.
  const stationery = stationeryOf(draft.stationery) ?? undefined;
  const imageData = layoutType === 'header_image'
    ? draft.header_image_data
    : layoutType === 'inline_image' ? draft.inline_image_data : null;
  // With the draft's own signature (#608), under the new sign-off's first line.
  const letter = { bodyText, signOff, layoutType, imageData: imageData ?? undefined, signatureImage: draft.signature_image || undefined, stationery };
  // A gift letter pays for one page only (#579): its words are held to one
  // page and refused in a gift's words when they run past it, never priced
  // again (#593 review round 1).
  const gift = draft.is_gift_send === true;
  if (gift && bodyText.length + signOff.length > RENDERED_LETTER_CHARACTER_CAP) {
    throw refused('GIFT_LETTER_ONE_PAGE', GIFT_ONE_PAGE, context);
  }

  // As a preview checks its words: their length, what prints, then the page.
  validateCharacterLimitForLayout(bodyText, signOff, layoutType, context, 'pdf');
  validatePrintableLetter({ sender, recipient, bodyText, signOff, senderIsSaved: false }, context, 'pdf', undefined, stationery);
  let layout: Layout;
  try {
    layout = layoutLetterForPreview(letter, context, 'pdf', gift ? 1 : limit)!;
  } catch (error) {
    if (gift && letterRunsPast(letter, 1)) {
      // Signed, and fitting one page without the signature: the way out (#608).
      const signedOnly = letter.signatureImage !== undefined && !letterRunsPast({ ...letter, signatureImage: undefined }, 1);
      throw refused('GIFT_LETTER_ONE_PAGE', signedOnly ? `${GIFT_ONE_PAGE} ${SIGNATURE_GIFT_WORDS}` : GIFT_ONE_PAGE, context);
    }
    throw error;
  }
  const pages = layout.pages.length;

  // The letter's pages drawn again, as many as it takes now; the pages after
  // the letter's own, a gift letter's card, as they were.
  const previewHtml = redrawLetterPreview(
    { previewHtml: draft.preview_html, pages: pagesBefore },
    layout,
    { sender, recipient, bodyText, signOff },
    stationery
  );
  if (previewHtml === null) throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);

  // With the stationery it was drawn in and the words it replaces, refused if
  // either changed meanwhile.
  const refusal = await setDraftWords(
    draftId,
    userId,
    // Drawn with the draft's signature (#608), which set_letter_signature changes in place.
    { bodyText, signOff, previewHtml, pages, drawnIn: draft.stationery, replacing, drawnWith: draft.signature_image },
    context.now()
  );
  if (refusal) throw refused(...REFUSALS[refusal], context);

  // Counts only: the words never reach the log.
  context.logger.info(
    { correlationId: context.correlationId, event: 'draft.words_changed', pages, pagesBefore, characters: bodyText.length + signOff.length },
    "A preview's words were changed"
  );
  // Priced as it stands now: the pages are the draft's, as the send and the
  // checkout read them.
  const payment = letterPayment(letterOption(layout, draft.mail_service), Number(draft.required_credits ?? 2), gift, context, draftId);
  // Never for certified mail (#625): no gift letter pays for it, and a new preview that used one would drop the service.
  const note =
    pages === 1 && pagesBefore > 1 && !payment.canSendNow && !gift && mailServiceOf(draft.mail_service) === undefined
      ? await giftLetterNote(context)
      : '';
  return {
    draftId,
    previewHtml,
    ...(pages > 1 ? { pages } : {}),
    ...payment,
    pageFit: pageFit(layout, stationery),
    wordsVersion: wordsVersionOf(bodyText, signOff),
    message: messageFor(pages, pagesBefore, note, already, draft.mail_service)
  };
}

export const setLetterWordsTool: McpToolDefinition<SetLetterWordsInput, SetLetterWordsOutput> = {
  name: SET_LETTER_WORDS_TOOL,
  title: "Change the letter's words",
  description:
    'Change the words of a previewed letter without previewing it again. Give the draftId from the preview, ' +
    'bodyText and signOff in full, as the letter previews take them, and the wordsVersion of the words being replaced, ' +
    'from the preview or the last change of words. The letter card can change the words too: if they changed since you ' +
    'saw them, nothing is changed, and the answer gives the words as they are now. The letter is laid out again in its ' +
    'stationery on up to three pages: a longer letter prints on both sides and is paid with Pay & Send, and a gift letter ' +
    'stays on one page. Nothing is sent by this tool.',
  readOnly: false,
  inputSchema: setLetterWordsInputSchema,
  outputSchema: setLetterWordsOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Changing the words...',
    'openai/toolInvocation/invoked': 'Words changed',
    // The letter card's Words tab calls it.
    'openai/widgetAccessible': true,
    // Changes only a draft's words, and only words its caller has seen
    // (wordsVersion), which that caller can set again: a draft expires on its
    // own and sends nothing, and the same words twice change nothing more.
    readOnlyHint: false,
    idempotentHint: true
  },
  handler
};

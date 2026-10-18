import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import type { ClientProfile } from '../auth/clientProfiles.js';
import { letterPageLimit } from '../config/roomToWrite.js';
import { isWordsEditorOffered } from '../config/wordsEditor.js';
import { isGiftLettersEnabled } from '../config/giftLetters.js';
import { mailServiceOf } from '../config/products.js';
import type { SendEligibility } from '../services/commerceService.js';
import { getGiftBalance } from '../services/giftLetterService.js';
import { stationeryOf, type Layout, type PageFit } from '../render/index.js';
import { getDraftForStationery, readDraftMailService, setDraftWords } from '../services/draftService.js';
import {
  layoutLetterForPreview,
  letterPayment,
  letterRunsPast,
  pageChangeSentence,
  SIGNATURE_GIFT_WORDS,
  redrawLetterPreview,
  RENDERED_LETTER_CHARACTER_CAP,
  validateCharacterLimitForLayout,
  validatePrintableLetter,
  wordsVersionOf,
  type LetterTravel,
  editorPageFit
} from './letterHelpers.js';
import { draftLetter, draftRefusals, draftRefuser, editableDraft, type DraftRefusal } from './draftEdit.js';
import { letterOption } from '../services/mailOptions.js';

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

export interface SetLetterWordsOutput extends LetterTravel {
  /** The draft's content version once changed (#695): the send takes it back. */
  contentVersion?: string;
  /** The version the change was made to (#695): a card takes contentVersion only when this is the one it shows. */
  contentVersionBefore?: string;
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
 * The draft's state, refused in a change of words' words (#690). 'changed': its
 * stationery, or its words, changed while the page was drawn again. Only
 * WORDS_CHANGED gives the words, as they are now: the caller's own read of them.
 */
export const WORDS_REFUSALS = draftRefusals({
  mail: 'letter',
  what: 'its words',
  remake: 'Make a new preview with the words',
  retry: 'words'
});

const NOT_DRAWN: DraftRefusal = ['DRAFT_NOT_DRAWN', 'This preview was not drawn in a way that can take new words. Make a new preview with them.'];

const GIFT_ONE_PAGE =
  'This letter is sent as a gift letter, which is one page, and these words run past it. ' +
  'Shorten them to fit one page, or make a new preview to send it another way.';

const refused = draftRefuser('draft.words_refused', 'A change of words was refused');

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
  if (!isWordsEditorOffered()) {
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
  const userId = context.user.userId;
  // Read before the lock, to say why at once; setDraftWords checks again under it.
  const { draftId, draft } = await editableDraft(
    {
      draftId: input.draftId,
      read: getDraftForStationery,
      mailType: 'letter',
      wrongKind: ['DRAFT_NOT_A_LETTER', "A postcard's words are its message: make a new postcard preview with them."],
      // Only a letter our renderer drew can be drawn again with new words.
      drawn: found => Boolean(found.renderer_version),
      notDrawn: NOT_DRAWN,
      refusals: WORDS_REFUSALS,
      refuse: refused
    },
    context
  );

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
  // The draft's addresses, layout and picture; its pages before, its own then any gift card's.
  // A gift letter pays for one page only (#579): its words are held to one page and refused
  // in a gift's words when they run past it, never priced again (#593 review round 1).
  const { sender, recipient, layoutType, imageData, pagesBefore, gift } = draftLetter(draft);
  // In the stationery it is drawn in now, as the print reads it back.
  const stationery = stationeryOf(draft.stationery) ?? undefined;
  // With the draft's own signature (#608), under the new sign-off's first line.
  const letter = { bodyText, signOff, layoutType, imageData, signatureImage: draft.signature_image || undefined, stationery };
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
  if (previewHtml === null) throw refused(...NOT_DRAWN, context);

  // With the stationery it was drawn in and the words it replaces, refused if
  // either changed meanwhile.
  let contentVersion: string | undefined;
  let contentVersionBefore: string | undefined;
  const refusal = await setDraftWords(
    draftId,
    userId,
    // Drawn with the draft's signature (#608), which set_letter_signature changes in place.
    { bodyText, signOff, previewHtml, pages, drawnIn: draft.stationery, replacing, drawnWith: draft.signature_image },
    context.now(), (version, before) => { contentVersion = version; contentVersionBefore = before; }
  );
  if (refusal) throw refused(...WORDS_REFUSALS[refusal], context);

  // Counts only: the words never reach the log. Words the letter already had are told apart: the model is asked to
  // send them to read the words (#795 review round 2), and that is no change.
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: already ? 'draft.words_unchanged' : 'draft.words_changed',
      pages,
      pagesBefore,
      characters: bodyText.length + signOff.length
    },
    already ? "A preview's words were sent as they are" : "A preview's words were changed"
  );
  // Priced as it stands now: the pages are the draft's, as the send and the
  // checkout read them.
  // How it travels as it is now, not as read before the lock (#625 follow-up).
  const service = (await readDraftMailService(draftId)) ?? draft.mail_service;
  const payment = letterPayment(letterOption(layout, service), Number(draft.required_credits ?? 2), gift, context, draftId);
  // Never for certified mail (#625): no gift letter pays for it, and a new preview that used one would drop the service.
  const note =
    pages === 1 && pagesBefore > 1 && !payment.canSendNow && !gift && mailServiceOf(service) === undefined
      ? await giftLetterNote(context)
      : '';
  return {
    ...(contentVersion ? { contentVersion, contentVersionBefore } : {}),
    draftId,
    previewHtml,
    ...(pages > 1 ? { pages } : {}),
    ...payment,
    pageFit: editorPageFit(layout, stationery),
    wordsVersion: wordsVersionOf(bodyText, signOff),
    message: messageFor(pages, pagesBefore, note, already, service)
  };
}

export const setLetterWordsTool: McpToolDefinition<SetLetterWordsInput, SetLetterWordsOutput> = {
  name: SET_LETTER_WORDS_TOOL,
  title: "Change the letter's words",
  // The pages it lays out on follow room to write (#586); without it, the words editor alone keeps a letter on one page (#647).
  // Where the app shows our letter card (#795 review round 1), the person may change the words
  // there unseen: a read is then a call with the words last seen, which changes nothing either way.
  description: (client?: ClientProfile) =>
    'Change the words of a previewed letter without previewing it again. Give the draftId from the preview, ' +
    'bodyText and signOff in full, as the letter previews take them, and the wordsVersion of the words being replaced, ' +
    'from the preview or the last change of words. ' +
    (client?.rendersCards
      ? 'The person can change the words on the letter card too, and you do not see those changes: a change to words ' +
        'that changed since you saw them changes nothing, and its answer gives the words as they are now. Before saying ' +
        'a word is or is not in the letter, call this with the words and wordsVersion you last saw: if they changed ' +
        'since, the answer gives them as they are now; if not, the letter already has them and nothing changes. '
      : 'The letter card can change the words too: if they changed since you saw them, nothing is changed, and the ' +
        'answer gives the words as they are now. ') +
    'The letter is laid out again in its ' +
    (letterPageLimit() > 1
      ? 'stationery on up to three pages: a longer letter prints on both sides and is paid with Pay & Send, and a gift letter ' +
        'stays on one page.'
      : 'stationery on one page: words that do not fit are refused.'),
  readOnly: false,
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

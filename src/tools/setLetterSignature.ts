import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { letterPageLimit } from '../config/roomToWrite.js';
import { isWordsEditorOffered } from '../config/wordsEditor.js';
import type { SendEligibility } from '../services/commerceService.js';
import { SIGNATURE_LINES, stationeryOf, type PageFit } from '../render/index.js';
import { getDraftForStationery, setDraftSignature } from '../services/draftService.js';
import { getSignature } from '../services/signatureService.js';
import { PAGE_WORDS, editorPageFit, layoutLetterForPreview, letterPayment, letterRunsPast, pageChangeSentence, redrawLetterPreview, type LetterTravel } from './letterHelpers.js';
import { letterOption } from '../services/mailOptions.js';
import { draftLetter, draftRefusals, draftRefuser, editableDraft, type DraftRefusal } from './draftEdit.js';
import { requireSignatures, signatureImageUri } from './signatureShared.js';
import type { PreviewSignatureOutput } from './signatureInput.js';

/**
 * A letter preview signed or unsigned without previewing it again (#608,
 * part 4): the letter is laid out again with or without the person's saved
 * signature, so a band that has no room is refused, and the draft keeps its
 * own copy of the signature, with its page drawn again, only while it waits
 * to be sent (setDraftSignature). The account remembers the choice for its
 * next letter preview, as a preview's explicit `signature` is remembered.
 * Nothing is sent here.
 *
 * Listed only while signatures are offered (src/server.ts), and refused while
 * they are not. The letter card's Signature switch calls it too.
 */
export const SET_LETTER_SIGNATURE_TOOL = 'set_letter_signature';

interface SetLetterSignatureInput {
  draftId: string;
  /** Required by the served schema; a direct call without one is refused. */
  signature: boolean;
}

export interface SetLetterSignatureOutput extends LetterTravel {
  /** The draft's content version once changed (#695): the send takes it back. */
  contentVersion?: string;
  /** The version the change was made to (#695): a card takes contentVersion only when this is the one it shows. */
  contentVersionBefore?: string;
  draftId: string;
  /** Whether the letter now prints the saved signature: asked for, always. */
  signature: PreviewSignatureOutput;
  /** The preview drawn again: for the card, in _meta, never the model's (partitionToolResult). */
  previewHtml: string;
  /** A letter of more than one page (#586): the pages it is laid out on now. */
  pages?: number;
  /** What it costs now: the band's three lines can change its pages, and so its price. */
  canSendNow: boolean;
  reasonCannotSend?: string;
  sendEligibility: SendEligibility;
  /** While room to write is offered: how full its pages are now, for the card's fit line. Card-only (_meta). */
  pageFit?: PageFit;
  message: string;
}

/** The draft's state, refused in a signature change's words (#690). 'changed': its words, stationery or signature changed while the page was drawn again. */
export const SIGNATURE_REFUSALS = draftRefusals({
  mail: 'letter',
  what: 'its signature',
  previewTakes: 'the letter previews take signature themselves',
  retry: 'signature'
});

const NOT_DRAWN: DraftRefusal = [
  'DRAFT_NOT_DRAWN',
  'This preview was not drawn in a way that can take a signature. Make a new preview, with signature if you like.'
];

const refused = draftRefuser('draft.signature_refused', 'A signature change was refused');

/** A signature with no room: the band's lines, and the page the letter may not run past. */
function noRoom(maxPages: number, gift: boolean): string {
  const limit = gift ? "a gift letter's one page" : PAGE_WORDS[maxPages] ?? `${maxPages} pages`;
  return `The signature takes ${SIGNATURE_LINES} lines, and this letter has no room for them on ${limit}. Shorten the message, then add the signature.`;
}

/**
 * What the tool says it did, for the model and the person, and what changed
 * in the letter's pages, and so its price (#586).
 */
function messageFor(signed: boolean, pages: number, pagesBefore: number, mailService?: string | null): string {
  // Off is true with none saved too: the next previews print none unless asked.
  const what = signed
    ? "The letter now prints the person's saved signature under the closing, and the account's next letter previews print it too"
    : "The letter now prints no signature, and the account's next letter previews leave it off unless they ask for it";
  const length = pageChangeSentence(pages, pagesBefore, mailService);
  return `${what}.${length} Nothing has been sent.`;
}

async function handler(input: SetLetterSignatureInput, context: ToolContext): Promise<SetLetterSignatureOutput> {
  requireSignatures();
  if (typeof input.signature !== 'boolean') {
    throw refused('SIGNATURE_CHOICE_MISSING', 'Say signature: true to print the saved signature, or false to leave it off.', context);
  }
  const userId = context.user.userId;
  // Read before the lock, to say why at once; setDraftSignature checks again under it.
  const { draftId, draft } = await editableDraft(
    {
      draftId: input.draftId,
      read: getDraftForStationery,
      mailType: 'letter',
      wrongKind: ['DRAFT_NOT_A_LETTER', 'A signature is for letters. A postcard prints none.'],
      // Only a letter our renderer drew can be drawn again with a signature.
      drawn: found => Boolean(found.renderer_version),
      notDrawn: NOT_DRAWN,
      refusals: SIGNATURE_REFUSALS,
      refuse: refused
    },
    context
  );

  // The saved signature, read once: the draft keeps this copy, so replacing
  // the saved one later never changes this letter.
  let signatureImage: string | null = null;
  if (input.signature) {
    const saved = await getSignature(userId);
    if (!saved) {
      throw refused(
        'SIGNATURE_NOT_SAVED',
        'No signature is saved. Ask the person for a photo of their signature and save it with set_signature, then try again.',
        context
      );
    }
    signatureImage = signatureImageUri(saved.png);
  }

  const { sender, recipient, bodyText, signOff, layoutType, imageData, pagesBefore, gift } = draftLetter(draft);
  // In the stationery it was drawn in: a theme no build draws is drawn Classic,
  // as the redraws read it.
  const stationery = stationeryOf(draft.stationery) ?? undefined;
  // On as many pages as a preview may take (#586), and a gift letter on one:
  // it pays for one page only (#579).
  const maxPages = gift ? 1 : letterPageLimit();
  const letter = { bodyText, signOff, layoutType, imageData, signatureImage: signatureImage ?? undefined, stationery };
  let layout;
  try {
    layout = layoutLetterForPreview(letter, context, 'pdf', maxPages)!;
  } catch (error) {
    // The letter fitted without the band, as its preview did: when it now
    // runs past, the band is what has no room. Any other refusal is its own.
    if (signatureImage !== null && letterRunsPast(letter, maxPages)) throw refused('SIGNATURE_NO_ROOM', noRoom(maxPages, gift), context);
    throw error;
  }

  // The letter's pages drawn again, as many as it takes now; the pages after
  // the letter's own, a gift letter's card, as they were.
  const previewHtml = redrawLetterPreview(
    { previewHtml: draft.preview_html, pages: pagesBefore },
    layout,
    { sender, recipient, bodyText, signOff },
    stationery
  );
  if (previewHtml === null) throw refused(...NOT_DRAWN, context);
  const pages = layout.pages.length;

  // With what it was drawn from, refused if any of it changed meanwhile.
  let contentVersion: string | undefined;
  let contentVersionBefore: string | undefined;
  const refusal = await setDraftSignature(
    draftId,
    userId,
    {
      signatureImage,
      previewHtml,
      pages,
      drawnFrom: {
        words: { bodyText: draft.body_text, signOff: draft.sign_off },
        stationery: draft.stationery,
        signature: draft.signature_image
      }
    },
    context.now(), (version, before) => { contentVersion = version; contentVersionBefore = before; }
  );
  if (refusal) throw refused(...SIGNATURE_REFUSALS[refusal], context);

  context.logger.info(
    { correlationId: context.correlationId, event: 'draft.signature_changed', signed: signatureImage !== null, pages, pagesBefore },
    'A preview was signed or unsigned'
  );
  // Priced as it stands now: the pages are the draft's, as the send and the
  // checkout read them (#586).
  const payment = letterPayment(letterOption(layout, draft.mail_service), Number(draft.required_credits ?? 2), gift, context, draftId);
  return {
    ...(contentVersion ? { contentVersion, contentVersionBefore } : {}),
    draftId,
    signature: { printed: signatureImage !== null, source: 'asked' },
    previewHtml,
    ...(pages > 1 ? { pages } : {}),
    ...payment,
    ...(isWordsEditorOffered() ? { pageFit: editorPageFit(layout, stationery) } : {}),
    message: messageFor(signatureImage !== null, pages, pagesBefore, draft.mail_service)
  };
}

export const setLetterSignatureTool: McpToolDefinition<SetLetterSignatureInput, SetLetterSignatureOutput> = {
  name: SET_LETTER_SIGNATURE_TOOL,
  title: 'Sign or unsign a letter',
  description:
    "Print the person's saved signature on a previewed letter, under the closing, or take it off, without previewing it again. " +
    'Give the draftId from the preview and signature: true or false. set_signature saves a signature first; true with none saved is refused. ' +
    `The signature takes ${SIGNATURE_LINES} lines, so a letter with no room for them is refused. The page is drawn again with the signature as it is saved now, ` +
    'and the choice is remembered for the next letter preview.',
  readOnly: false,
  meta: {
    'openai/toolInvocation/invoking': 'Changing the signature...',
    'openai/toolInvocation/invoked': 'Signature changed',
    // The letter card's Signature switch calls it (#608).
    'openai/widgetAccessible': true,
    // Changes only a draft's signature: a draft expires on its own and sends
    // nothing, and the same choice twice changes nothing more.
    readOnlyHint: false,
    idempotentHint: true
  },
  handler
};

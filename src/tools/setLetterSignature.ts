import type { Address, LetterLayoutType, McpToolDefinition, ToolContext } from '../contracts/types.js';
import { setLetterSignatureInputSchema, setLetterSignatureOutputSchema } from '../schemas.js';
import { letterPageLimit } from '../config/roomToWrite.js';
import type { SendEligibility } from '../services/commerceService.js';
import { pageFit, SIGNATURE_LINES, stationeryOf, type PageFit } from '../render/index.js';
import { getDraftForStationery, setDraftSignature, type DraftRedrawRefusal } from '../services/draftService.js';
import { getSignature } from '../services/signatureService.js';
import { layoutLetterForPreview, letterOption, letterPayment, letterRunsPast, redrawLetterPreview } from './letterHelpers.js';
import { isDraftIdShape } from './requestSend.js';
import { requireSignatures, SignatureRefusedError, signatureImageUri, type SignatureRefusalCode } from './signatureShared.js';
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

export interface SetLetterSignatureOutput {
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

const REFUSALS: Record<DraftRedrawRefusal, [SignatureRefusalCode, string]> = {
  not_found: ['DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
  sent: ['DRAFT_ALREADY_SENT', "This letter has already been sent, so its signature can't change. list_orders shows it."],
  expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take signature themselves.'],
  checkout_pending: ['DRAFT_CHECKOUT_PENDING', "This preview is tied to a Pay & Send payment, so its signature can't change now."],
  // Its words, stationery or signature changed while the page was drawn again.
  changed: ['DRAFT_CHANGED', 'The letter changed while its page was being drawn again. Try the signature again.']
};

const NOT_DRAWN = 'This preview was not drawn in a way that can take a signature. Make a new preview, with signature if you like.';

function refused(code: SignatureRefusalCode, message: string, context: ToolContext): SignatureRefusedError {
  context.logger.warn(
    { correlationId: context.correlationId, event: 'draft.signature_refused', reason: code },
    'A signature change was refused'
  );
  return new SignatureRefusedError(code, message);
}

const PAGE_WORDS = ['', 'one page', 'two pages', 'three pages'];

/** A signature with no room: the band's lines, and the page the letter may not run past. */
function noRoom(maxPages: number, gift: boolean): string {
  const limit = gift ? "a gift letter's one page" : PAGE_WORDS[maxPages] ?? `${maxPages} pages`;
  return `The signature takes ${SIGNATURE_LINES} lines, and this letter has no room for them on ${limit}. Shorten the message, then add the signature.`;
}

/**
 * What the tool says it did, for the model and the person, and what changed
 * in the letter's pages, and so its price (#586).
 */
function messageFor(signed: boolean, pages: number, pagesBefore: number): string {
  // Off is true with none saved too: the next previews print none unless asked.
  const what = signed
    ? "The letter now prints the person's saved signature under the closing, and the account's next letter previews print it too"
    : "The letter now prints no signature, and the account's next letter previews leave it off unless they ask for it";
  const length =
    pages === pagesBefore
      ? ''
      : pages === 1
        ? ' It now fits on one page, which a letter pack pays for.'
        : ` It now runs to ${PAGE_WORDS[pages]}, printed on both sides, and is paid with Pay & Send.`;
  return `${what}.${length} Nothing has been sent.`;
}

async function handler(input: SetLetterSignatureInput, context: ToolContext): Promise<SetLetterSignatureOutput> {
  requireSignatures();
  if (typeof input.signature !== 'boolean') {
    throw refused('SIGNATURE_CHOICE_MISSING', 'Say signature: true to print the saved signature, or false to leave it off.', context);
  }
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  const userId = context.user.userId;
  const draft = isDraftIdShape(draftId) ? await getDraftForStationery(draftId, userId) : null;
  if (!draft) throw refused(...REFUSALS.not_found, context);
  if (draft.mail_type !== 'letter') {
    throw refused('DRAFT_NOT_A_LETTER', 'A signature is for letters. A postcard prints none.', context);
  }
  // Read before the lock, to say why at once; setDraftSignature checks again
  // under it. A draft an erasure emptied is refused as the lock refuses it.
  if (draft.status === 'consumed') throw refused(...REFUSALS.sent, context);
  if (draft.status !== 'pending' || draft.redacted_at || !(new Date(draft.expires_at).getTime() > context.now().getTime())) {
    throw refused(...REFUSALS.expired, context);
  }
  // Only a letter our renderer drew can be drawn again with a signature.
  if (!draft.renderer_version) throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);

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

  const pagesBefore = Number(draft.pages ?? 1);
  const sender = draft.sender as unknown as Address;
  const recipient = draft.recipient as unknown as Address;
  const bodyText = draft.body_text;
  const signOff = draft.sign_off ?? '';
  const layoutType = (draft.layout_type ?? 'text_only') as LetterLayoutType;
  // In the stationery it was drawn in: a theme no build draws is drawn Classic,
  // as the redraws read it.
  const stationery = stationeryOf(draft.stationery) ?? undefined;
  const imageData = layoutType === 'header_image'
    ? draft.header_image_data
    : layoutType === 'inline_image' ? draft.inline_image_data : null;
  // On as many pages as a preview may take (#586), and a gift letter on one:
  // it pays for one page only (#579).
  const gift = draft.is_gift_send === true;
  const maxPages = gift ? 1 : letterPageLimit();
  const letter = { bodyText, signOff, layoutType, imageData: imageData ?? undefined, signatureImage: signatureImage ?? undefined, stationery };
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
  if (previewHtml === null) throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);
  const pages = layout.pages.length;

  // With what it was drawn from, refused if any of it changed meanwhile.
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
    context.now()
  );
  if (refusal) throw refused(...REFUSALS[refusal], context);

  context.logger.info(
    { correlationId: context.correlationId, event: 'draft.signature_changed', signed: signatureImage !== null, pages, pagesBefore },
    'A preview was signed or unsigned'
  );
  // Priced as it stands now: the pages are the draft's, as the send and the
  // checkout read them (#586).
  const payment = letterPayment(letterOption(layout), Number(draft.required_credits ?? 2), gift, context, draftId);
  return {
    draftId,
    signature: { printed: signatureImage !== null, source: 'asked' },
    previewHtml,
    ...(pages > 1 ? { pages } : {}),
    ...payment,
    ...(letterPageLimit() > 1 ? { pageFit: pageFit(layout, stationery) } : {}),
    message: messageFor(signatureImage !== null, pages, pagesBefore)
  };
}

export const setLetterSignatureTool: McpToolDefinition<SetLetterSignatureInput, SetLetterSignatureOutput> = {
  name: SET_LETTER_SIGNATURE_TOOL,
  title: 'Sign or unsign a letter',
  description:
    "Print the person's saved signature on a previewed letter, under the closing, or take it off, without previewing it again. " +
    'Give the draftId from the preview and signature: true or false. set_signature saves a signature first; true with none saved is refused. ' +
    `The signature takes ${SIGNATURE_LINES} lines, so a letter with no room for them is refused. The page is drawn again with the signature as it is saved now, ` +
    'and the choice is remembered for the next letter preview. Nothing is sent by this tool.',
  readOnly: false,
  inputSchema: setLetterSignatureInputSchema,
  outputSchema: setLetterSignatureOutputSchema,
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

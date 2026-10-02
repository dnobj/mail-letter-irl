import type { Address, LetterLayoutType, McpToolDefinition, ToolContext } from '../contracts/types.js';
import { setStationeryInputSchema, setStationeryOutputSchema } from '../schemas.js';
import { isStationeryOffered } from '../config/stationery.js';
import { letterPageLimit } from '../config/roomToWrite.js';
import type { SendEligibility } from '../services/commerceService.js';
import { renderPreviewSvg, rendererVersionFor, type Stationery } from '../render/index.js';
import type { PreviewStationery } from './stationeryInput.js';
import {
  getDraftForStationery,
  setDraftStationery,
  type DraftScheduleRefusal
} from '../services/draftService.js';
import {
  renderedPageImage,
  rendererDocumentPages,
  renderLetterPreviewDocument,
  stampedAddressLines
} from '../services/previewService.js';
import { layoutLetterForPreview, letterOption, letterPayment, validatePrintableLetter, withDisplayImage } from './letterHelpers.js';
import { isDraftIdShape } from './requestSend.js';
import { previewStationery, THEME_LIST } from './stationeryInput.js';

/**
 * A letter preview's stationery, changed without previewing it again (#563).
 * The theme is checked as the letter previews check theirs
 * (previewStationery); the letter is laid out again in it, so a headline that
 * pushes it past its page or initials the font cannot draw are refused in the
 * same words; and the draft is restyled, with its page drawn again, only
 * while it waits to be sent (setDraftStationery). The account remembers the
 * theme for its next letter preview. Nothing is sent here.
 *
 * Listed only while stationery is offered (src/server.ts), and refused while
 * it is not, for an app that cached the list. The letter card's Style control
 * calls it too.
 */
export const SET_STATIONERY_TOOL = 'set_stationery';

interface SetStationeryInput {
  draftId: string;
  /** Required by the served schema; a direct call without one is refused. */
  stationery: string;
  monogram?: string;
  headline?: string;
}

export interface SetStationeryOutput {
  draftId: string;
  /** The stationery the page is now drawn in: asked for, always. */
  stationery: PreviewStationery;
  /** The preview drawn again: for the card, in _meta, never the model's (partitionToolResult). */
  previewHtml: string;
  /** A letter of more than one page (#586): the pages it is laid out on now. */
  pages?: number;
  /** What it costs now (#586): a restyle can change its pages, and so its price. */
  canSendNow: boolean;
  reasonCannotSend?: string;
  sendEligibility: SendEligibility;
  message: string;
}

/**
 * Refusals the model can act on. Like set_arrival_date's, none repeats the
 * draft id, and the code doubles as the log's class.
 */
export class StationeryRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(
    readonly code:
      | 'STATIONERY_DISABLED'
      | 'STATIONERY_MISSING'
      | 'DRAFT_NOT_FOUND'
      | 'DRAFT_ALREADY_SENT'
      | 'DRAFT_EXPIRED'
      | 'DRAFT_CHECKOUT_PENDING'
      | 'DRAFT_NOT_A_LETTER'
      | 'DRAFT_NOT_DRAWN',
    message: string
  ) {
    super(message);
    this.name = 'StationeryRefusedError';
    this.diagnosticClass = code;
  }
}

const REFUSALS: Record<DraftScheduleRefusal, [StationeryRefusedError['code'], string]> = {
  not_found: ['DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
  sent: ['DRAFT_ALREADY_SENT', "This letter has already been sent, so its stationery can't change. list_orders shows it."],
  expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the letter previews take stationery themselves.'],
  checkout_pending: [
    'DRAFT_CHECKOUT_PENDING',
    "This preview is tied to a Pay & Send payment, so its stationery can't change now."
  ]
};

const NOT_DRAWN =
  "This preview was not drawn in a way that can take stationery. Make a new preview, with stationery if you like.";

function refused(code: StationeryRefusedError['code'], message: string, context: ToolContext): StationeryRefusedError {
  context.logger.warn(
    { correlationId: context.correlationId, event: 'draft.stationery_refused', reason: code },
    'A stationery change was refused'
  );
  return new StationeryRefusedError(code, message);
}

const PAGE_WORDS = ['', 'one page', 'two pages', 'three pages'];

/**
 * What the tool says it did, for the model and the person, and what changed
 * in the letter's pages, and so its price (#586).
 */
function messageFor(stationery: Stationery, pages: number, pagesBefore: number): string {
  const drawn = stationery.theme === 'classic' ? 'on a plain page, the classic stationery' : `on the ${stationery.theme} stationery`;
  const length =
    pages === pagesBefore
      ? ''
      : pages === 1
        ? ' It now fits on one page, which a letter pack pays for.'
        : ` It now runs to ${PAGE_WORDS[pages]}, printed on both sides, and is paid with Pay & Send.`;
  return `The letter is now ${drawn}, and the account remembers it for its next letter preview.${length} Nothing has been sent.`;
}

async function handler(input: SetStationeryInput, context: ToolContext): Promise<SetStationeryOutput> {
  if (!isStationeryOffered()) {
    throw refused('STATIONERY_DISABLED', 'Stationery is not available yet. The preview stays as it is.', context);
  }
  // A restyle names its theme: none would fall back to the remembered one.
  if (typeof input.stationery !== 'string' || input.stationery.trim() === '') {
    throw refused('STATIONERY_MISSING', `Name the stationery: ${THEME_LIST}.`, context);
  }
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  const userId = context.user.userId;
  const draft = isDraftIdShape(draftId) ? await getDraftForStationery(draftId, userId) : null;
  if (!draft) throw refused(...REFUSALS.not_found, context);
  if (draft.mail_type !== 'letter') {
    throw refused('DRAFT_NOT_A_LETTER', 'Stationery is for letters. A postcard keeps its own design.', context);
  }
  // Read before the lock, to say why at once; setDraftStationery checks again
  // under it. A draft an erasure emptied is refused as the lock refuses it,
  // before its empty content is laid out (#573 review round 3).
  if (draft.status === 'consumed') throw refused(...REFUSALS.sent, context);
  if (draft.status !== 'pending' || draft.redacted_at || !(new Date(draft.expires_at).getTime() > context.now().getTime())) {
    throw refused(...REFUSALS.expired, context);
  }
  // Only a letter our renderer drew can be drawn again in a theme.
  if (!draft.renderer_version) throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);
  // The pages its preview drew (#586): its own, then any gift card's.
  const pagesBefore = Number(draft.pages ?? 1);

  const sender = draft.sender as unknown as Address;
  const recipient = draft.recipient as unknown as Address;
  const bodyText = draft.body_text;
  const signOff = draft.sign_off ?? '';
  const layoutType = (draft.layout_type ?? 'text_only') as LetterLayoutType;

  // The theme first, then what it prints, then the page, as a preview checks them.
  const stationery = previewStationery(
    { stationery: input.stationery, monogram: input.monogram, headline: input.headline },
    sender.name,
    context,
    'pdf'
  )!;
  validatePrintableLetter({ sender, recipient, bodyText, signOff, senderIsSaved: false }, context, 'pdf', undefined, stationery);
  const imageData = layoutType === 'header_image'
    ? draft.header_image_data
    : layoutType === 'inline_image' ? draft.inline_image_data : null;
  const layout = layoutLetterForPreview(
    { bodyText, signOff, layoutType, imageData: imageData ?? undefined, stationery },
    context,
    'pdf',
    // On as many pages as a preview may take (#586), and a gift letter on one:
    // it pays for one page only (#579), so a theme that runs it past is refused.
    draft.is_gift_send ? 1 : letterPageLimit()
  )!;

  // The letter's pages drawn again, as many as it takes now, with the small
  // copy of its picture from whichever page showed it; the pages after the
  // letter's own, a gift letter's card, as they were.
  const stored = rendererDocumentPages(draft.preview_html);
  const letterPages = stored.slice(0, pagesBefore);
  const after = stored.slice(pagesBefore);
  const image = letterPages.map(renderedPageImage).find(found => found !== undefined);
  const drawsImage = layout.pages.some(page => page.items.some(item => item.kind === 'image'));
  if (letterPages.length < pagesBefore || letterPages.length === 0 || (drawsImage && !image)) {
    throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);
  }
  const drawn = renderPreviewSvg(withDisplayImage(layout, image), {
    addresses: { from: stampedAddressLines(sender), to: stampedAddressLines(recipient) }
  });
  const rendererVersion = rendererVersionFor(stationery);
  const previewHtml = renderLetterPreviewDocument([...drawn, ...after], { bodyText, signOff }, rendererVersion);
  const pages = layout.pages.length;

  const refusal = await setDraftStationery(draftId, userId, { stationery, previewHtml, pages }, context.now());
  if (refusal) throw refused(...REFUSALS[refusal], context);

  context.logger.info(
    { correlationId: context.correlationId, event: 'draft.stationery_changed', theme: stationery.theme, pages, pagesBefore },
    'A preview was restyled'
  );
  // Priced as it stands now: the pages are the draft's, as the send and the
  // checkout read them (#586).
  const payment = letterPayment(letterOption(layout), Number(draft.required_credits ?? 2), draft.is_gift_send === true, context, draftId);
  return {
    draftId,
    stationery,
    previewHtml,
    ...(pages > 1 ? { pages } : {}),
    ...payment,
    message: messageFor(stationery, pages, pagesBefore)
  };
}

export const setStationeryTool: McpToolDefinition<SetStationeryInput, SetStationeryOutput> = {
  name: SET_STATIONERY_TOOL,
  title: 'Change the stationery',
  description:
    'Change the stationery of a previewed letter without previewing it again: classic (a plain page), monogram ' +
    '(initials in a ring), botanical (a line-drawn sprig), celebration (confetti with an optional headline), ' +
    'typewriter (typed in a monospace face) or handwritten (a handwriting face on faint ruled lines). ' +
    'Give the draftId from the preview and stationery, with monogram and headline as the letter previews take them: ' +
    'each call states them afresh, so a headline is kept only when given again. ' +
    'The page is drawn again, and the choice is remembered for the next letter preview. Nothing is sent by this tool.',
  readOnly: false,
  inputSchema: setStationeryInputSchema,
  outputSchema: setStationeryOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Changing the stationery...',
    'openai/toolInvocation/invoked': 'Stationery changed',
    // The letter card's Style control calls it (#563).
    'openai/widgetAccessible': true,
    // Changes only a draft's style: a draft expires on its own and sends
    // nothing, and the same style twice changes nothing more.
    readOnlyHint: false,
    idempotentHint: true
  },
  handler
};

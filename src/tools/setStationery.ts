import type { Address, LetterLayoutType, McpToolDefinition, ToolContext } from '../contracts/types.js';
import { setStationeryInputSchema, setStationeryOutputSchema } from '../schemas.js';
import { isStationeryOffered } from '../config/stationery.js';
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
import { layoutLetterForPreview, validatePrintableLetter, withDisplayImage } from './letterHelpers.js';
import { isDraftIdShape } from './requestSend.js';
import { previewStationery } from './stationeryInput.js';

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
  stationery?: string;
  monogram?: string;
  headline?: string;
}

export interface SetStationeryOutput {
  draftId: string;
  /** The stationery the page is now drawn in: asked for, always. */
  stationery: PreviewStationery;
  /** The preview drawn again: for the card, in _meta, never the model's (partitionToolResult). */
  previewHtml: string;
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

/** What the tool says it did, for the model and the person. */
function messageFor(stationery: Stationery): string {
  const drawn = stationery.theme === 'classic' ? 'on a plain page, the classic stationery' : `on the ${stationery.theme} stationery`;
  return `The letter is now ${drawn}, and it is remembered for the next letter preview. Nothing has been sent.`;
}

async function handler(input: SetStationeryInput, context: ToolContext): Promise<SetStationeryOutput> {
  if (!isStationeryOffered()) {
    throw refused('STATIONERY_DISABLED', 'Stationery is not available yet. The preview stays as it is.', context);
  }
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  const userId = context.user.userId;
  const draft = isDraftIdShape(draftId) ? await getDraftForStationery(draftId, userId) : null;
  if (!draft) throw refused(...REFUSALS.not_found, context);
  if (draft.mail_type !== 'letter') {
    throw refused('DRAFT_NOT_A_LETTER', 'Stationery is for letters. A postcard keeps its own design.', context);
  }
  // Read before the lock, to say why at once; setDraftStationery checks again under it.
  if (draft.status === 'consumed') throw refused(...REFUSALS.sent, context);
  if (draft.status !== 'pending' || !(new Date(draft.expires_at).getTime() > context.now().getTime())) {
    throw refused(...REFUSALS.expired, context);
  }
  // Only a letter our renderer drew can be drawn again in a theme.
  if (!draft.renderer_version) throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);

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
    'pdf'
  )!;

  // The letter's page drawn again, with the small copy of its picture the
  // preview showed; the pages after it, a gift letter's card, as they were.
  const [page, ...after] = rendererDocumentPages(draft.preview_html);
  const image = page ? renderedPageImage(page) : undefined;
  if (!page || (layout.pages[0].items.some(item => item.kind === 'image') && !image)) {
    throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);
  }
  const [drawn] = renderPreviewSvg(withDisplayImage(layout, image), {
    addresses: { from: stampedAddressLines(sender), to: stampedAddressLines(recipient) }
  });
  const rendererVersion = rendererVersionFor(stationery);
  const previewHtml = renderLetterPreviewDocument([drawn, ...after], { bodyText, signOff }, rendererVersion);

  const refusal = await setDraftStationery(draftId, userId, { stationery, rendererVersion, previewHtml }, context.now());
  if (refusal) throw refused(...REFUSALS[refusal], context);

  context.logger.info(
    { correlationId: context.correlationId, event: 'draft.stationery_changed', theme: stationery.theme },
    'A preview was restyled'
  );
  return { draftId, stationery, previewHtml, message: messageFor(stationery) };
}

export const setStationeryTool: McpToolDefinition<SetStationeryInput, SetStationeryOutput> = {
  name: SET_STATIONERY_TOOL,
  title: 'Change the stationery',
  description:
    'Change the stationery of a previewed letter without previewing it again: classic (a plain page), monogram ' +
    '(initials in a ring), botanical (a line-drawn sprig) or celebration (confetti with an optional headline). ' +
    'Give the draftId from the preview and stationery; monogram and headline as the letter previews take them. ' +
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

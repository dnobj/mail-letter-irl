import type { McpToolDefinition, ToolContext } from '../contracts/types.js';
import { isCustomStationeryOffered } from '../config/customStationery.js';
import { isStationeryOffered } from '../config/stationery.js';
import { letterPageLimit } from '../config/roomToWrite.js';
import { isWordsEditorOffered } from '../config/wordsEditor.js';
import type { SendEligibility } from '../services/commerceService.js';
import { CUSTOM_THEME, type PageFit } from '../render/index.js';
import { getDesign } from '../services/stationeryDesignService.js';
import type { PreviewStationery } from './stationeryInput.js';
import { getDraftForStationery, setDraftStationery } from '../services/draftService.js';
import { withDisplaySignature } from '../services/signatureDisplay.js';
import { editorPageFit, layoutLetterForPreview, letterPayment, pageChangeSentence, redrawLetterPreview, validatePrintableLetter, type LetterTravel } from './letterHelpers.js';
import { letterOption } from '../services/mailOptions.js';
import { draftLetter, draftRefusals, draftRefuser, editableDraft, type DraftRefusal } from './draftEdit.js';
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
  /** A theme, or, while designs are offered, stationeryDesignId (#649): one of the two; none is refused. */
  stationery?: string;
  stationeryDesignId?: string;
  monogram?: string;
  headline?: string;
}

export interface SetStationeryOutput extends LetterTravel {
  /** The draft's content version once changed (#695): the send takes it back. */
  contentVersion?: string;
  /** The version the change was made to (#695): a card takes contentVersion only when this is the one it shows. */
  contentVersionBefore?: string;
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
  /** While room to write is offered: how full its pages are now, for the card's fit line. Card-only (_meta). */
  pageFit?: PageFit;
  message: string;
}

/** The draft's state, refused in a restyle's words (#690). 'changed': its words changed while the page was drawn again (#586). */
export const STATIONERY_REFUSALS = draftRefusals({
  mail: 'letter',
  what: 'its stationery',
  previewTakes: 'the letter previews take stationery themselves',
  retry: 'stationery'
});

const NOT_DRAWN: DraftRefusal = [
  'DRAFT_NOT_DRAWN',
  "This preview was not drawn in a way that can take stationery. Make a new preview, with stationery if you like."
];

const refused = draftRefuser('draft.stationery_refused', 'A stationery change was refused');

/**
 * What the tool says it did, for the model and the person, and what changed
 * in the letter's pages, and so its price (#586).
 */
function messageFor(stationery: PreviewStationery, pages: number, pagesBefore: number, mailService?: string | null): string {
  const drawn =
    stationery.theme === CUSTOM_THEME
      ? `on the saved stationery design "${stationery.name}"`
      : stationery.theme === 'classic'
        ? 'on a plain page, the classic stationery'
        : `on the ${stationery.theme} stationery`;
  const length = pageChangeSentence(pages, pagesBefore, mailService);
  return `The letter is now ${drawn}, and the account remembers it for its next letter preview.${length} Nothing has been sent.`;
}

async function handler(input: SetStationeryInput, context: ToolContext): Promise<SetStationeryOutput> {
  if (!isStationeryOffered()) {
    throw refused('STATIONERY_DISABLED', 'Stationery is not available yet. The preview stays as it is.', context);
  }
  // A restyle names its theme or a saved design (#649): none would fall back to the remembered one.
  const named = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  const designs = isCustomStationeryOffered();
  if (!named(input.stationery) && !(designs && named(input.stationeryDesignId))) {
    throw refused(
      'STATIONERY_MISSING',
      designs
        ? `Name the stationery: ${THEME_LIST}, or a saved design's stationeryDesignId.`
        : `Name the stationery: ${THEME_LIST}.`,
      context
    );
  }
  const userId = context.user.userId;
  // Read before the lock, to say why at once; setDraftStationery checks again under it.
  const { draftId, draft } = await editableDraft(
    {
      draftId: input.draftId,
      read: getDraftForStationery,
      mailType: 'letter',
      wrongKind: ['DRAFT_NOT_A_LETTER', 'Stationery is for letters. A postcard keeps its own design.'],
      // Only a letter our renderer drew can be drawn again in a theme.
      drawn: found => Boolean(found.renderer_version),
      notDrawn: NOT_DRAWN,
      refusals: STATIONERY_REFUSALS,
      refuse: refused
    },
    context
  );
  const { sender, recipient, bodyText, signOff, layoutType, imageData, pagesBefore, gift } = draftLetter(draft);

  // The theme first, then what it prints, then the page, as a preview checks them. A design is
  // read as a preview reads it: only the account's own (#649).
  const designId = typeof input.stationeryDesignId === 'string' ? input.stationeryDesignId.trim() : '';
  const askedDesign = designs && designId !== '' && !named(input.stationery) ? await getDesign(userId, designId) : null;
  const stationery = previewStationery(
    { stationery: input.stationery, monogram: input.monogram, headline: input.headline, stationeryDesignId: input.stationeryDesignId },
    sender.name,
    context,
    'pdf',
    null,
    askedDesign
  )!;
  validatePrintableLetter({ sender, recipient, bodyText, signOff, senderIsSaved: false }, context, 'pdf', undefined, stationery);
  const layout = layoutLetterForPreview(
    // With the draft's own signature (#608), which a restyle keeps.
    { bodyText, signOff, layoutType, imageData, signatureImage: draft.signature_image || undefined, stationery },
    context,
    'pdf',
    // On as many pages as a preview may take (#586), and a gift letter on one:
    // it pays for one page only (#579), so a theme that runs it past is refused.
    gift ? 1 : letterPageLimit()
  )!;

  // The letter's pages drawn again, as many as it takes now; the pages after
  // the letter's own, a gift letter's card, as they were.
  const previewHtml = redrawLetterPreview(
    { previewHtml: draft.preview_html, pages: pagesBefore },
    // The signature from its small copy (#614); the print keeps the stored one.
    await withDisplaySignature(layout),
    { sender, recipient, bodyText, signOff },
    stationery
  );
  if (previewHtml === null) throw refused(...NOT_DRAWN, context);
  const pages = layout.pages.length;

  // With the words it was drawn from, refused if they changed meanwhile (#586).
  let contentVersion: string | undefined;
  let contentVersionBefore: string | undefined;
  // How the written row travels, read with its version under the lock (#625 follow-up).
  let writtenService: string | null | undefined;
  const refusal = await setDraftStationery(
    draftId,
    userId,
    // And with the signature it was drawn with (#608), which set_letter_signature changes in place.
    { stationery, previewHtml, pages, drawnFrom: { bodyText: draft.body_text, signOff: draft.sign_off, signature: draft.signature_image } },
    context.now(), (version, before, written) => { contentVersion = version; contentVersionBefore = before; writtenService = written.mailService; }
  );
  if (refusal) throw refused(...STATIONERY_REFUSALS[refusal], context);

  context.logger.info(
    { correlationId: context.correlationId, event: 'draft.stationery_changed', theme: stationery.theme, pages, pagesBefore },
    'A preview was restyled'
  );
  // Priced as it stands now: the pages are the draft's, as the send and the
  // checkout read them (#586).
  // How the written letter travels, not as read before the lock (#625 follow-up); as read when the version was not.
  const service = writtenService === undefined ? draft.mail_service : writtenService;
  const payment = letterPayment(letterOption(layout, service), Number(draft.required_credits ?? 2), gift, context, draftId);
  return {
    ...(contentVersion ? { contentVersion, contentVersionBefore } : {}),
    draftId,
    stationery,
    previewHtml,
    ...(pages > 1 ? { pages } : {}),
    ...payment,
    ...(isWordsEditorOffered() ? { pageFit: editorPageFit(layout, stationery) } : {}),
    message: messageFor(stationery, pages, pagesBefore, service)
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
    'The page is drawn again, and the choice is remembered for the next letter preview.',
  readOnly: false,
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

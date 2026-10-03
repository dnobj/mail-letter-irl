import type { Address, McpToolDefinition, ToolContext } from '../contracts/types.js';
import { setPostcardStyleInputSchema, setPostcardStyleOutputSchema } from '../schemas.js';
import { isPostcardSizesOffered, offeredPostcardSizes } from '../config/postcardSizes.js';
import { isPostcardLayoutsOffered } from '../config/postcardLayouts.js';
import { isPackPayable } from '../config/products.js';
import type { SendEligibility } from '../services/commerceService.js';
import type { PostcardSize } from '../services/types.js';
import {
  layoutPostcard,
  layoutPostcardBack,
  POSTCARD_GEOMETRY,
  postcardFrontOf,
  readImageDataUri,
  renderPreviewSvg,
  type PostcardFront,
  type RenderImage
} from '../render/index.js';
import { getDraftForPostcardStyle, setDraftPostcardStyle, type DraftRedrawRefusal } from '../services/draftService.js';
import { ImageProcessingError, reprocessPostcardImage } from '../services/imageService.js';
import {
  renderedPageImage,
  rendererDocumentPages,
  renderPostcardPreviewDocument,
  stampedAddressLines,
  stampedPostcardReturnLines
} from '../services/previewService.js';
import { letterPayment, validatePrintableCharacters, withDisplayImage } from './letterHelpers.js';
import { fitPostcardFront, frontPrintedText, previewPostcardFront, type PostcardLayoutChoice } from './postcardFrontInput.js';
import { RENDERED_POSTCARD_CHARACTER_CAPS } from './quoteAndPreviewPostcard.js';
import { isDraftIdShape } from './requestSend.js';

/**
 * A postcard preview's size and front, changed without previewing it again
 * (#594): the postcard maker on the card calls it, and so may the model.
 * Each is checked as the postcard preview checks it, the postcard is drawn
 * again, and the draft restyled only while it waits to be sent
 * (setDraftPostcardStyle). It is priced again: a 4x6 or 11x6 is paid per send
 * with Pay & Send (#579). Nothing is sent here.
 *
 * Listed only while the sizes or the layouts are offered (src/server.ts),
 * each argument served only while its own is, and refused while neither is,
 * for an app that cached the list.
 */
export const SET_POSTCARD_STYLE_TOOL = 'set_postcard_style';

interface SetPostcardStyleInput {
  draftId: string;
  size?: unknown;
  layout?: unknown;
  caption?: unknown;
  place?: unknown;
}

export interface SetPostcardStyleOutput {
  draftId: string;
  /** The size it is now: 6x9, or 6x4 (a 4x6) or 6x11 (an 11x6). */
  size: PostcardSize;
  /** The front it has now, with its caption or place. */
  layout: PostcardLayoutChoice;
  caption?: string;
  place?: string;
  /** The postcard drawn again: for the card, in _meta, never the model's (partitionToolResult). */
  previewHtml: string;
  /** What it costs now: a new size can change how it is paid. */
  canSendNow: boolean;
  reasonCannotSend?: string;
  sendEligibility: SendEligibility;
  message: string;
}

/**
 * Refusals the model can act on. Like set_stationery's, none repeats the
 * draft id, and the code doubles as the log's class.
 */
export class PostcardStyleRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(
    readonly code:
      | 'POSTCARD_STYLES_DISABLED'
      | 'STYLE_MISSING'
      | 'SIZE_NOT_OFFERED'
      | 'DRAFT_NOT_FOUND'
      | 'DRAFT_ALREADY_SENT'
      | 'DRAFT_EXPIRED'
      | 'DRAFT_CHECKOUT_PENDING'
      | 'DRAFT_NOT_A_POSTCARD'
      | 'DRAFT_NOT_DRAWN'
      | 'DRAFT_CHANGED'
      | 'GIFT_POSTCARD_SIZE'
      | 'COLLAGE_SIZE'
      | 'MESSAGE_TOO_LONG'
      | 'PICTURE_UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'PostcardStyleRefusedError';
    this.diagnosticClass = code;
  }
}

const REFUSALS: Record<DraftRedrawRefusal, [PostcardStyleRefusedError['code'], string]> = {
  not_found: ['DRAFT_NOT_FOUND', "That preview wasn't found. Make a new preview, then try again."],
  sent: ['DRAFT_ALREADY_SENT', "This postcard has already been sent, so its size and layout can't change. list_orders shows it."],
  expired: ['DRAFT_EXPIRED', 'This preview has expired. Make a new preview: the postcard preview takes a size and a layout itself.'],
  checkout_pending: [
    'DRAFT_CHECKOUT_PENDING',
    "This preview is tied to a Pay & Send payment, so its size and layout can't change now."
  ],
  // Another change redrew it while this one was drawing.
  changed: ['DRAFT_CHANGED', 'The postcard changed while it was being drawn again. Try the change again.']
};

const NOT_DRAWN =
  'This preview was not drawn in a way that can change its size or layout. Make a new preview, with the size and layout you want.';

/** Each size as a sentence names it, the short side first. */
const SIZE_NAMES: Readonly<Record<PostcardSize, string>> = { '6x9': 'a 6x9', '6x4': 'a 4x6', '6x11': 'an 11x6' };

function refused(code: PostcardStyleRefusedError['code'], message: string, context: ToolContext): PostcardStyleRefusedError {
  context.logger.warn(
    { correlationId: context.correlationId, event: 'draft.postcard_style_refused', reason: code },
    'A postcard style change was refused'
  );
  return new PostcardStyleRefusedError(code, message);
}

/** Whether an argument was given: present, and not empty or blank, which models send for one left unset. */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

function sameFront(a: PostcardFront | undefined, b: PostcardFront | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The front as a sentence says it. */
function frontWords(front: PostcardFront | undefined): string {
  if (!front) return 'the photo across the front';
  if (front.layout === 'border') {
    return front.caption === undefined ? 'the photo in a white border' : `the photo in a white border over "${front.caption}"`;
  }
  return `"Greetings from ${front.place}" over the photo`;
}

/** What the tool says it did, for the model and the person, and how it is paid when its size changed. */
function messageFor(size: PostcardSize, front: PostcardFront | undefined, sizeBefore: PostcardSize, packPays: boolean): string {
  const paid = size === sizeBefore
    ? ''
    : packPays
      ? ' A letter pack pays for this size.'
      : ' This size is paid per send with Pay & Send, at its own price.';
  return `The postcard is now ${SIZE_NAMES[size]}, with ${frontWords(front)}.${paid} Nothing has been sent.`;
}

async function handler(input: SetPostcardStyleInput, context: ToolContext): Promise<SetPostcardStyleOutput> {
  if (!isPostcardSizesOffered() && !isPostcardLayoutsOffered()) {
    throw refused('POSTCARD_STYLES_DISABLED', 'Postcard sizes and layouts are not available yet. The preview stays as it is.', context);
  }
  const askedSize = given(input.size);
  const askedFront = given(input.layout) || given(input.caption) || given(input.place);
  if (!askedSize && !askedFront) {
    throw refused('STYLE_MISSING', 'Name what to change: the size, or the layout with its caption or place.', context);
  }
  const draftId = typeof input.draftId === 'string' ? input.draftId.trim() : '';
  const userId = context.user.userId;
  const draft = isDraftIdShape(draftId) ? await getDraftForPostcardStyle(draftId, userId) : null;
  if (!draft) throw refused(...REFUSALS.not_found, context);
  if (draft.mail_type !== 'postcard') {
    throw refused('DRAFT_NOT_A_POSTCARD', 'Sizes and layouts are for postcards. A letter changes its look with set_stationery.', context);
  }
  // Read before the lock, to say why at once; setDraftPostcardStyle checks
  // again under it. A draft an erasure emptied is refused as the lock
  // refuses it, before its empty content is drawn.
  if (draft.status === 'consumed') throw refused(...REFUSALS.sent, context);
  if (draft.status !== 'pending' || draft.redacted_at || !(new Date(draft.expires_at).getTime() > context.now().getTime())) {
    throw refused(...REFUSALS.expired, context);
  }
  // Only a postcard our renderer drew, whose front reads as the print reads it.
  const frontBefore = draft.postcard_front == null ? undefined : postcardFrontOf(draft.postcard_front) ?? undefined;
  const storedPages = rendererDocumentPages(draft.preview_html);
  if (!draft.renderer_version || !draft.front_image_data || storedPages.length !== 2 || (draft.postcard_front != null && !frontBefore)) {
    throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);
  }

  const sizeBefore: PostcardSize = draft.postcard_size ?? '6x9';
  let size = sizeBefore;
  if (askedSize) {
    const named = typeof input.size === 'string' ? input.size.trim().toLowerCase() : '';
    if (!(offeredPostcardSizes() as readonly string[]).includes(named)) {
      throw refused(
        'SIZE_NOT_OFFERED',
        `The size must be ${offeredPostcardSizes().join(', ').replace(/, ([^,]*)$/, ' or $1')}.`,
        context
      );
    }
    size = named as PostcardSize;
  }
  // A gift letter pays for a 6x9 only (#579), and the print holds a gift card on any other.
  if (draft.is_gift_send && size !== '6x9') {
    throw refused(
      'GIFT_POSTCARD_SIZE',
      'A gift postcard is a 6x9: the gift letter pays for that size only. To send another size, make a new preview with sendAsGift set to false.',
      context
    );
  }

  // A collage keeps the size it was made at (#616). Its photos were read once
  // and are not kept, so only the picture it prints from remains, and cropping
  // that again would cut the photos at its edges, and more at every change.
  // Every single photo's draft records the link it came from; a collage's has
  // none (quoteAndPreviewPostcard stores it null).
  if (size !== sizeBefore && draft.front_image_url == null) {
    throw refused(
      'COLLAGE_SIZE',
      'A collage keeps the size it was made at: its photos were read once and are not kept, so they cannot be arranged again. ' +
        'To change the size, make a new preview with quote_and_preview_postcard: the same photos in images or imageUrls, the same message and front, and the size you want. The postcard stays as it is.',
      context
    );
  }

  // The front asked for, checked as the preview checks it at this size; or
  // the front it has, measured again at a new size.
  const front = askedFront
    ? previewPostcardFront(input, size, context, 'pdf')
    : frontBefore && fitPostcardFront(frontBefore, size, context);

  const sender = draft.sender as Address;
  const recipient = draft.recipient as Address;
  const payment = (to: PostcardSize) =>
    letterPayment({ mailType: 'postcard', postcardSize: to }, Number(draft.required_credits ?? 2), draft.is_gift_send === true, context, draftId);

  // The same style again changes nothing: the postcard is as it was.
  if (size === sizeBefore && sameFront(front, frontBefore)) {
    return {
      draftId,
      size,
      layout: front?.layout ?? 'full_bleed',
      ...frontText(front),
      previewHtml: draft.preview_html!,
      ...payment(size),
      message: `The postcard is already ${SIZE_NAMES[size]}, with ${frontWords(front)}. Nothing has changed, and nothing has been sent.`
    };
  }

  // A front's line in the face and case it prints in.
  const lines = frontPrintedText(front);
  if (lines.length > 0) validatePrintableCharacters('postcard', lines, { sender, recipient, senderIsSaved: false }, context);

  // At a new size the back is measured again, as the preview measures it.
  const message = draft.body_text;
  if (size !== sizeBefore) {
    const { page, overflowLines } = layoutPostcardBack(message, undefined, size);
    if (message.length > RENDERED_POSTCARD_CHARACTER_CAPS[size] || overflowLines > 0) {
      throw refused(
        'MESSAGE_TOO_LONG',
        `The message is too long for the back of ${SIZE_NAMES[size]} postcard: it takes ${page.linesUsed} lines and the back holds ` +
          `${page.linesAvailable}. Keep its size, or make a new preview with a shorter message.`,
        context
      );
    }
  }

  // The picture: cropped again at a new size; otherwise the one it prints,
  // shown by the small copy on its front page.
  let printImage = draft.front_image_data;
  let displayImage = renderedPageImage(storedPages[0]);
  let croppedAgain: string | undefined;
  if (size !== sizeBefore) {
    try {
      const picture = await reprocessPostcardImage({ url: draft.front_image_url, stored: draft.front_image_data }, size, { actorId: userId });
      printImage = croppedAgain = picture.base64DataUri;
      displayImage = picture.previewDataUri;
      context.logger.info(
        { correlationId: context.correlationId, event: 'draft.postcard_picture_cropped', size, from: picture.from },
        "A postcard's picture was cropped again at its new size"
      );
    } catch (error) {
      if (!(error instanceof ImageProcessingError)) throw error;
      throw refused('PICTURE_UNAVAILABLE', `${error.userMessage} The postcard stays as it is.`, context);
    }
  } else if (!displayImage) {
    throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);
  }

  // The picture as it prints; a stored one that cannot be read is a draft
  // that cannot be drawn again, as the print would refuse it (#601 review round 1).
  let image: RenderImage;
  try {
    image = readImageDataUri(printImage);
  } catch {
    throw refused('DRAFT_NOT_DRAWN', NOT_DRAWN, context);
  }
  // The front drawn again; the back too at a new size, and otherwise as it
  // was, a gift card's strip with it.
  const drawn = renderPreviewSvg(
    withDisplayImage(layoutPostcard({ message, image, size, ...front }), displayImage),
    {
      addresses: { from: stampedPostcardReturnLines(sender), to: stampedAddressLines(recipient) },
      stamp: { page: 1, geometry: POSTCARD_GEOMETRY[size].stamp }
    }
  );
  const previewHtml = renderPostcardPreviewDocument(size === sizeBefore ? [drawn[0], storedPages[1]] : drawn);

  const refusal = await setDraftPostcardStyle(
    draftId,
    userId,
    { size, front: front ?? null, previewHtml, frontImageData: croppedAgain, drawnFrom: { previewHtml: draft.preview_html } },
    context.now()
  );
  if (refusal) throw refused(...REFUSALS[refusal], context);

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: 'draft.postcard_style_changed',
      size,
      sizeBefore,
      layout: front?.layout ?? 'full_bleed'
    },
    'A postcard preview was restyled'
  );
  return {
    draftId,
    size,
    layout: front?.layout ?? 'full_bleed',
    ...frontText(front),
    previewHtml,
    ...payment(size),
    message: messageFor(size, front, sizeBefore, isPackPayable({ mailType: 'postcard', postcardSize: size }))
  };
}

/** The caption or place of a front, for the output. */
function frontText(front: PostcardFront | undefined): Pick<SetPostcardStyleOutput, 'caption' | 'place'> {
  if (front?.layout === 'border') return front.caption === undefined ? {} : { caption: front.caption };
  if (front?.layout === 'greetings') return { place: front.place };
  return {};
}

export const setPostcardStyleTool: McpToolDefinition<SetPostcardStyleInput, SetPostcardStyleOutput> = {
  name: SET_POSTCARD_STYLE_TOOL,
  title: 'Change the postcard style',
  // In the words of what is offered, read as the tools are listed, so a model
  // is never steered to an argument this deployment withholds (#601 review round 1).
  description: () => {
    const sizes = isPostcardSizesOffered();
    const layouts = isPostcardLayoutsOffered();
    return (
      `Change a previewed postcard's ${sizes && layouts ? 'size or front layout' : sizes ? 'size' : 'front layout'} without previewing it again. ` +
      `Give the draftId from the preview, and ${
        sizes && layouts ? 'the size, the layout with its caption or place, or both' : sizes ? 'the size' : 'the layout with its caption or place'
      }. ` +
      (sizes && layouts ? 'A size or layout left out stays as it is. ' : '') +
      (layouts ? 'A layout given replaces the front, so give its caption again to keep it. ' : '') +
      (sizes
        ? 'The postcard is drawn again and priced again: the 4x6 and 11x6 are paid per send with Pay & Send. '
        : 'The postcard is drawn again. ') +
      'Nothing is sent by this tool.'
    );
  },
  readOnly: false,
  inputSchema: setPostcardStyleInputSchema,
  outputSchema: setPostcardStyleOutputSchema,
  meta: {
    'openai/toolInvocation/invoking': 'Changing the postcard...',
    'openai/toolInvocation/invoked': 'Postcard changed',
    // The postcard maker on the card calls it (#594).
    'openai/widgetAccessible': true,
    // Changes only a draft's style: a draft expires on its own and sends
    // nothing, and the same style twice changes nothing more.
    readOnlyHint: false,
    idempotentHint: true
  },
  handler
};

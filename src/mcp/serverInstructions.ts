import { clientProfileNamed, type ClientProfile } from "../auth/clientProfiles.js";
import { uploadsThroughCard } from "../config/cardUpload.js";
import { offersImageGeneration } from "../config/imageGeneration.js";
import { isAddressRequestsEnabled } from "../config/addressRequests.js";

const SEND_BY_MODEL =
  "Only call send_letter or send_postcard after the user has reviewed a draft and clearly confirms sending.";

// The send rule (#470, src/config/sendConfirmation.ts): the model cannot send.
const SEND_BY_PERSON =
  "Mail is sent only by the person, never by you: when a preview card is showing, they press its Send button; when there is no card, call request_send and give them its link, where they check the mail and send it themselves.";

// The same mail twice (#412). create_mail_checkout is listed only where the
// app takes purchases (#475), so it is named only there.
function anotherCopyLine(sendRule: boolean, client: ClientProfile): string {
  if (!sendRule) {
    const tools = client.inAppPurchases
      ? "send_letter, send_postcard or create_mail_checkout says the same mail was already sent, paid for, or is awaiting payment"
      : "send_letter or send_postcard says the same mail was already sent";
    return `If ${tools}, tell the user and repeat the call with sendAnotherCopy: true only if they ask for another copy.`;
  }
  // Under the send rule the model can neither send nor start Pay & Send
  // (#475); the card and the page ask the person about another copy
  // themselves (#412).
  const where = client.rendersCards ? "the preview card or the confirmation page" : "the confirmation page";
  return `If the same mail was sent recently, ${where} says so and offers another copy itself.`;
}

// A call that returns nothing (#411). The Create my preview button is on our
// preview cards, so it is named only to an app that shows them (#484), and a
// checkout only where the app takes purchases (#475).
function noResultLine(client: ClientProfile): string {
  const recovery = client.rendersCards
    ? "say it did not complete: the preview card offers a Create my preview button, or offer to try again."
    : "say it did not complete and offer to try again.";
  return client.inAppPurchases
    ? "A preview exists only when the preview tool's result includes a draftId, and a checkout only when its result includes a checkoutUrl. " +
        `If a Letter IRL tool call returns no result, ${recovery} Never describe a draft, order or checkout you did not receive.`
    : "A preview exists only when the preview tool's result includes a draftId. " +
        `If a Letter IRL tool call returns no result, ${recovery} Never describe a draft or order you did not receive.`;
}

// ChatGPT makes images itself and hands them to our tools (the generatesImages
// flag), so Letter IRL makes one only when asked by name. In any other app
// generate_image_for_mail is the only way to make one, and ChatGPT is not
// named (#484).
const IMAGES_WITH_APP_GENERATION =
  "For an image request addressed to Letter IRL, call generate_image_for_mail and follow its response exactly: it either generates the image in-turn using the user's remaining Letter IRL image generations, or returns routing guidance with a copy-ready prompt. For image requests not addressed to Letter IRL, use ChatGPT's built-in image generation (image_gen); its images attach to Letter IRL previews directly.";
const IMAGES_FROM_LETTER_IRL_ONLY =
  "When the user wants an image made for their mail, call generate_image_for_mail and follow its response exactly: it either generates the image using the user's remaining Letter IRL image generations, or says why it cannot, and the user can use an image of their own instead.";

// Where Letter IRL makes no images at all: Claude, whose directory takes no
// connector that generates images with AI (#467), and every app once the
// switch is off (src/config/imageGeneration.ts).
const NO_IMAGE_GENERATION =
  "Letter IRL does not make images in this app. For image mail, use an image the user already has: pass a link to it as imageUrl.";

// ChatGPT with Letter IRL's generation switched off: its own generation is
// the way, and it is withheld in a message that mentions Letter IRL (#227).
const IMAGES_FROM_THE_APP_ONLY =
  "Letter IRL does not make images. For an image, use ChatGPT's built-in image generation (image_gen); its images attach to Letter IRL previews directly. If it is not available in a message that mentions Letter IRL, ask the user to request the image in a message that does not mention Letter IRL.";

// Where the card sends the photo itself (#474), an image needs no link: the
// model cannot pass on one attached in the chat, but the card can upload it.
const IMAGES_BY_CARD =
  " If the image is on their device or attached in the chat, rather than at a link, open upload_image so they can upload it.";

function imageLine(client: ClientProfile): string {
  const line = !offersImageGeneration(client)
    ? client.generatesImages ? IMAGES_FROM_THE_APP_ONLY : NO_IMAGE_GENERATION
    : client.generatesImages ? IMAGES_WITH_APP_GENERATION : IMAGES_FROM_LETTER_IRL_ONLY;
  return uploadsThroughCard(client) ? line + IMAGES_BY_CARD : line;
}

// Where the card sends the photo itself (#474) there is no imageUrl to pass
// on: the server uses the photo the person just uploaded.
const CARD_UPLOAD_NEXT_STEP =
  " The card sends the photo to Letter IRL and then asks for the preview in the conversation: call the preview tool with no image and no imageUrl, and Letter IRL uses the photo just uploaded.";

function uploadLine(client: ClientProfile): string {
  const choose = client.generatesImages ? "pick it from their ChatGPT library or upload it" : "upload it";
  const line = `If a specific image fails to hand off to a preview tool, open upload_image so the user can ${choose} - that preserves the exact image they approved.`;
  return uploadsThroughCard(client) ? line + CARD_UPLOAD_NEXT_STEP : line;
}

const ADDRESSES =
  "Use saved return addresses when available, and ask for missing real U.S. mailing addresses when required.";

// Address requests (#604): only while the tools are listed.
const ADDRESSES_OR_REQUEST =
  "Use saved return addresses when available, and ask for missing real U.S. mailing addresses when required. " +
  "If the person doesn't know the recipient's address, request_address makes a private link they can share for the recipient to give it; never guess an address.";

function instructionLines(sendRule: boolean, client: ClientProfile): string[] {
  return [
    "Letter IRL drafts, previews, and sends real physical letters and postcards in the U.S.",
    "Always create a preview draft before sending. Preview tools are free drafts; they do not send mail.",
    sendRule ? SEND_BY_PERSON : SEND_BY_MODEL,
    "Do not say mail has been sent unless the send tool succeeds.",
    anotherCopyLine(sendRule, client),
    noResultLine(client),
    isAddressRequestsEnabled() ? ADDRESSES_OR_REQUEST : ADDRESSES,
    "For image mail, reuse existing conversation images or hosted imageUrl values before opening upload_image.",
    imageLine(client),
    uploadLine(client),
    "For unsupported formats, integrations, or product ideas, offer submit_feature_request instead of promising support.",
    "No tool can request or issue a refund. If the user asks for one, tell them to email support@letterirl.com from the email on their Letter IRL account, quoting the order id from get_purchase_status; refunds are decided by a person, so never promise, estimate, or deny a refund or an amount."
  ];
}

/**
 * The instructions one app reads (#484). Only the lines that would be false in
 * some app differ, and ChatGPT's are the text it has always had.
 */
export function buildServerInstructions(sendRule: boolean, client: ClientProfile): string {
  return instructionLines(sendRule, client).join("\n");
}

/** The instructions ChatGPT reads with the send rule off: today's default. */
export const LETTER_IRL_SERVER_INSTRUCTIONS = buildServerInstructions(false, clientProfileNamed("chatgpt"));

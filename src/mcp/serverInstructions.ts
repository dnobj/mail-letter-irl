import { clientProfileNamed, type ClientProfile } from "../auth/clientProfiles.js";

const SEND_BY_MODEL =
  "Only call send_letter or send_postcard after the user has reviewed a draft and clearly confirms sending.";

const ANOTHER_COPY_BY_MODEL =
  "If send_letter, send_postcard or create_mail_checkout says the same mail was already sent, paid for, or is awaiting payment, tell the user and repeat the call with sendAnotherCopy: true only if they ask for another copy.";

// The send rule (#470, src/config/sendConfirmation.ts): the model cannot send.
const SEND_BY_PERSON =
  "Mail is sent only by the person, never by you: when a preview card is showing, they press its Send button; when there is no card, call request_send and give them its link, where they check the mail and send it themselves.";

// Under the send rule the model cannot repeat a send; the card and the page
// ask the person about another copy themselves (#412).
const ANOTHER_COPY_BY_PERSON =
  "If create_mail_checkout says the same mail was already sent, paid for, or is awaiting payment, tell the user and repeat the call with sendAnotherCopy: true only if they ask for another copy. For a send, the preview card or the confirmation page offers another copy itself.";

// A call that returns nothing (#411). The Create my preview button is on our
// preview cards, so it is named only to an app that shows them (#484).
function noResultLine(client: ClientProfile): string {
  const recovery = client.rendersCards
    ? "say it did not complete: the preview card offers a Create my preview button, or offer to try again."
    : "say it did not complete and offer to try again.";
  return (
    "A preview exists only when the preview tool's result includes a draftId, and a checkout only when its result includes a checkoutUrl. " +
    `If a Letter IRL tool call returns no result, ${recovery} Never describe a draft, order or checkout you did not receive.`
  );
}

// ChatGPT makes images itself and hands them to our tools (the generatesImages
// flag), so Letter IRL makes one only when asked by name. In any other app
// generate_image_for_mail is the only way to make one, and ChatGPT is not
// named (#484).
const IMAGES_WITH_APP_GENERATION =
  "For an image request addressed to Letter IRL, call generate_image_for_mail and follow its response exactly: it either generates the image in-turn using the user's remaining Letter IRL image generations, or returns routing guidance with a copy-ready prompt. Never refuse an image request. For image requests not addressed to Letter IRL, use ChatGPT's built-in image generation (image_gen); its images attach to Letter IRL previews directly.";
const IMAGES_FROM_LETTER_IRL_ONLY =
  "When the user wants an image made for their mail, call generate_image_for_mail rather than refusing, and follow its response exactly: it either generates the image using the user's remaining Letter IRL image generations, or says why it cannot, and the user can use an image of their own instead.";

function uploadLine(client: ClientProfile): string {
  const choose = client.generatesImages ? "pick it from their ChatGPT library or upload it" : "upload it";
  return `If a specific image fails to hand off to a preview tool, open upload_image so the user can ${choose} - that preserves the exact image they approved.`;
}

function instructionLines(sendRule: boolean, client: ClientProfile): string[] {
  return [
    "Letter IRL drafts, previews, and sends real physical letters and postcards in the U.S.",
    "Always create a preview draft before sending. Preview tools are free drafts; they do not send mail.",
    sendRule ? SEND_BY_PERSON : SEND_BY_MODEL,
    "Do not say mail has been sent unless the send tool succeeds.",
    sendRule ? ANOTHER_COPY_BY_PERSON : ANOTHER_COPY_BY_MODEL,
    noResultLine(client),
    "Use saved return addresses when available, and ask for missing real U.S. mailing addresses when required.",
    "For image mail, reuse existing conversation images or hosted imageUrl values before opening upload_image.",
    client.generatesImages ? IMAGES_WITH_APP_GENERATION : IMAGES_FROM_LETTER_IRL_ONLY,
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

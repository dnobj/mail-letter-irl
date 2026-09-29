import type { ClientProfile } from "../auth/clientProfiles.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";

/**
 * The last sentence of a preview tool's description: how a preview is sent in
 * the calling app.
 *
 * Under the send rule (#470) no model sends mail, and Claude Code's model does
 * not even see send_letter or send_postcard, so the description must not tell
 * the model to call them. It names what this app offers instead, as the preview's
 * own text does (howToSendText, src/mcp/registerTools.ts). The description
 * matters more than that text: a model reads it every turn, and Claude Code's
 * model reads it where it is never shown the preview's text (#516).
 */
export function previewSendStep(
  sendTool: "send_letter" | "send_postcard",
  client: Pick<ClientProfile, "rendersCards">
): string {
  if (!isSendConfirmationEnabled()) return `Send later with ${sendTool}.`;
  return client.rendersCards
    ? "Nothing is sent from here: the person sends it with Send on the preview card, or, if no card shows, on the page request_send links to."
    : "Nothing is sent from here: to send it, call request_send and give the person its link.";
}

/**
 * send_letter's or send_postcard's description in the calling app.
 *
 * Under the send rule (#470) a send tool sends only for an app that keeps
 * card-only tools from its model (honorsCardOnlyTools), where the call can
 * only come from the person pressing Send on our card. Anywhere else the tool
 * stays listed, so a card shown there still reaches the link, and a call
 * answers with that link instead of sending (sendsByLinkOnly,
 * src/mcp/registerTools.ts). Those apps show the tool to their model, so this
 * says the call sends nothing and names request_send (#516). "Send a physical
 * letter" had the model promise a send that the call then refused.
 */
export function sendToolDescription(
  description: string,
  mail: "letter" | "postcard",
  client: Pick<ClientProfile, "honorsCardOnlyTools">
): string {
  if (!isSendConfirmationEnabled() || client.honorsCardOnlyTools) return description;
  return (
    `Does not send the ${mail} in this app: Letter IRL sends mail only when the person sends it. ` +
    `A call answers with the link to the page where they check the ${mail} and send it. ` +
    `Call request_send instead and give the person its link.`
  );
}

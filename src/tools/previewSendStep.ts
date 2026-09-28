import type { ClientProfile } from "../auth/clientProfiles.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";

/**
 * The last sentence of a preview tool's description: how a preview is sent in
 * the calling app.
 *
 * Under the send rule (#470) no model sends mail, and Claude Code does not even
 * list send_letter or send_postcard, so the description must not tell the
 * model to call them. It names what this app offers instead, as the preview's
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

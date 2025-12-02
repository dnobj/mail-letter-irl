import { Address } from "../contracts/types.js";

const DEFAULT_CHARS_PER_PAGE = 1800;

export interface PreviewInput {
  sender: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

export function estimateRequiredCredits(
  bodyText: string,
  signOff: string,
  charsPerPage = DEFAULT_CHARS_PER_PAGE
): number {
  // Flat rate: All letters cost 2 credits (one page maximum)
  // Character counting is kept for validation in sendLetter/quoteAndPreview tools
  return 2;
}

export function renderPreviewHtml(input: PreviewInput): string {
  return `<!doctype html><html><body><address>${input.sender.name}<br>${input.sender.addressLine1}</address><hr><p>${input.bodyText}</p><p>${input.signOff}</p></body></html>`;
}

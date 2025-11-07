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
  const totalCharacters = `${bodyText}\n\n${signOff}`.length;
  const pages = Math.ceil(totalCharacters / charsPerPage) || 1;
  const credits = Math.max(1, pages);
  return Math.ceil(credits * 2) / 2; // round up to nearest 0.5
}

export function renderPreviewHtml(input: PreviewInput): string {
  return `<!doctype html><html><body><address>${input.sender.name}<br>${input.sender.addressLine1}</address><hr><p>${input.bodyText}</p><p>${input.signOff}</p></body></html>`;
}

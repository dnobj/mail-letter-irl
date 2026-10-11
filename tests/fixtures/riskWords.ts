import { vi } from 'vitest';

/**
 * Sentences that rate a tool's own risk rather than say what it does (#543, #670). ChatGPT's approval dialog flagged
 * "This does not send mail" and "Nothing is sent by this tool" as a "Suspicious Instruction" steering its risk rating.
 * The annotations (readOnlyHint, destructiveHint, openWorldHint) carry the risk; the words say what the tool does.
 */
export const RATES_ITS_RISK =
  /nothing is (sent|previewed)|sends nothing|changes nothing|does(n't| not) send|not send (mail|the)|won't|never (sends|exposes|contacts)|only reads|read-only|is not sent|harmless|\bsafe\b|sanitized/i;

/** Every title and description in a tool's JSON: what a model, or a host's reviewer, reads. */
export function modelFacingStrings(node: unknown): string[] {
  return node && typeof node === 'object'
    ? Object.entries(node).flatMap(([key, value]) =>
        (key === 'description' || key === 'title') && typeof value === 'string' ? [value] : modelFacingStrings(value)
      )
    : [];
}

/** Every switch that changes the tool list or its words. */
export const FLAGS_THAT_CHANGE_TOOLS = [
  'LETTER_IRL_ADDRESS_REQUESTS_ENABLED',
  'LETTER_IRL_ARRIVE_BY_ENABLED',
  'LETTER_IRL_CARD_UPLOAD_ENABLED',
  'LETTER_IRL_CERTIFIED_MAIL_ENABLED',
  'LETTER_IRL_CUSTOM_STATIONERY_ENABLED',
  'LETTER_IRL_ENVELOPE_REVEAL_ENABLED',
  'LETTER_IRL_GIFT_LETTERS_ENABLED',
  'LETTER_IRL_HOME_ENABLED',
  'LETTER_IRL_POSTCARD_COLLAGES_ENABLED',
  'LETTER_IRL_POSTCARD_LAYOUTS_ENABLED',
  'LETTER_IRL_POSTCARD_SIZES_ENABLED',
  'LETTER_IRL_ROOM_TO_WRITE_ENABLED',
  'LETTER_IRL_SIGNATURES_ENABLED',
  'LETTER_IRL_STATIONERY_ENABLED',
  'LETTER_IRL_STUDIO_CARD_ENABLED',
  'LETTER_IRL_WORDS_EDITOR_ENABLED'
];

/** Every switch on or off. Stationery is offered only with the PDF renderer, and the options paid per send only with JIT. */
export function everyFlag(on: boolean): void {
  for (const flag of FLAGS_THAT_CHANGE_TOOLS) vi.stubEnv(flag, String(on));
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', on ? 'pdf' : '');
  vi.stubEnv('JIT_PURCHASE_ENABLED', String(on));
}

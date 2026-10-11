import { vi } from 'vitest';
import type { ImageGenMode } from '../../src/config/imageGeneration.js';

/**
 * The sentences #543 and #670 took out of the tools' descriptions and the instructions, kept out of them. ChatGPT's
 * approval dialog flagged "This does not send mail" and "Nothing is sent by this tool" as a "Suspicious Instruction"
 * steering its risk rating; the annotations (readOnlyHint, destructiveHint, openWorldHint) carry the risk, and the
 * words say what the tool does.
 *
 * This is the list of what was removed, not a pattern for every way of saying a tool is harmless: four review rounds
 * of #672 found such a pattern always missed one phrasing or refused a sentence a description may rightly say. The
 * rule for new words is the style guide's (docs/tool-description-style-guide.md), kept by review.
 */
export const REMOVED_RISK_SENTENCES = [
  'This does not send mail',
  'Nothing is sent from here',
  'Nothing is sent by this tool',
  'Nothing is previewed or sent',
  'Read-only',
  'sends nothing',
  'changes nothing',
  'does not send or cancel mail',
  'Does not send the letter',
  'Does not send the postcard',
  'it does not send anything',
  'Safe retries',
  'sanitized commerce state',
  'never exposes payment-card details',
  'never contacts them',
  'they do not send mail'
];

/** Any of the removed sentences, in any case. */
export const A_REMOVED_RISK_SENTENCE = new RegExp(
  REMOVED_RISK_SENTENCES.map(sentence => sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i'
);

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

/**
 * Every switch on or off. Stationery is offered only with the PDF renderer, and the options paid per send (certified
 * mail, room to write, the postcard sizes) only with JIT purchases, which `paidPerSend` sets apart: with every switch on
 * but JIT off, descriptions take the words they have without those options (a postcard's layouts without its sizes).
 * Image generation has modes of its own, each with its own instructions and tool list.
 */
export function everyFlag(on: boolean, paidPerSend = on, imageGen: ImageGenMode = on ? 'on' : 'off'): void {
  for (const flag of FLAGS_THAT_CHANGE_TOOLS) vi.stubEnv(flag, String(on));
  vi.stubEnv('LETTER_IRL_PRINT_RENDERER', on ? 'pdf' : '');
  vi.stubEnv('JIT_PURCHASE_ENABLED', String(paidPerSend));
  vi.stubEnv('LETTER_IRL_IMAGE_GEN_MODE', imageGen);
}

/** The switch states the risk checks read: every switch on (with each image mode), on but nothing paid per send, off. */
export const SWITCH_STATES: Array<[on: boolean, paidPerSend: boolean, imageGen: ImageGenMode]> = [
  [true, true, 'on'],
  [true, true, 'redirect'],
  [true, true, 'mobile_only'],
  [true, false, 'on'],
  [false, false, 'off']
];

import { vi } from 'vitest';
import type { ImageGenMode } from '../../src/config/imageGeneration.js';

/** A straight or a curly apostrophe. */
const APOSTROPHE = "['\u2019]";
/** What says a tool or a preview is not to do something. */
const NOT = `(does not|doesn${APOSTROPHE}t|do not|don${APOSTROPHE}t|will not|won${APOSTROPHE}t|cannot|can not|can${APOSTROPHE}t|never)`;
/** What a sentence rating a tool's own risk is about: the tool, its previews or drafts, not Letter IRL or the model. */
const SUBJECT = '(it|this|this tool|the tool|they|tools?|previews?|preview tools|drafts?)';

/**
 * Sentences that rate a tool's own risk rather than say what it does (#543, #670). ChatGPT's approval dialog flagged
 * "This does not send mail" and "Nothing is sent by this tool" as a "Suspicious Instruction" steering its risk rating.
 * The annotations (readOnlyHint, destructiveHint, openWorldHint) carry the risk; the words say what the tool does.
 *
 * These are the forms ChatGPT flagged and the forms close to them (#672's review rounds): a tool or a preview said not
 * to send, mail or charge; nothing sent, previewed or charged; read-only, safe, harmless, sanitized. It is not a
 * grammar of every way to say so, and it lets through what a description may rightly say: an instruction to the model
 * ("Do not send mail to a guessed address"), what Letter IRL does not do ("Letter IRL does not send the receipt"), and
 * what an action does ("Free until it goes to the printer: nothing is mailed"). The style guide states the rule
 * (docs/tool-description-style-guide.md).
 */
export const RATES_ITS_RISK = new RegExp(
  [
    '\\bnothing (is|will be|gets|has been) (sent|previewed|charged)\\b',
    '\\bno mail is sent\\b',
    '\\b(sends|changes|charges) nothing\\b',
    `\\b${SUBJECT} ${NOT} (send|sends|mail|mails|charge|charges)\\b`,
    '\\bnever exposes\\b',
    '\\bread[- ]?only\\b',
    '\\bonly reads\\b',
    '\\bno side effects?\\b',
    '\\bharmless\\b',
    `\\b(is|are|it${APOSTROPHE}s) safe\\b`,
    '\\bsafe(ly)? (to|retr)',
    '\\bsanitized\\b'
  ].join('|'),
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

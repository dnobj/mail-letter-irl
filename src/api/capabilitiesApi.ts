/**
 * What Letter IRL does and what it costs, as JSON (#630, release epic #816
 * C2): public, signed out and cacheable, for agents and for the website's
 * capabilities page and llms.txt, which are built from it.
 *
 *   GET /capabilities.json -> CapabilitiesDocument
 *
 * Built from the server's own tables on each request, so it cannot drift from
 * what the server charges: the prices from the product table
 * (src/config/products.ts), the options from the switches that offer them, and
 * the delivery words the previews use (src/content/delivery.ts). An option, and
 * its price, appear only while this deployment offers it, so production shows
 * only what production sells.
 *
 * It names no product codes, price ids, environment variables or flags: only
 * what a person can buy, at what price, and how it travels.
 *
 * Plain and factual (docs/tool-description-style-guide.md, #630): the job, the
 * cost, the delivery time, the limits and who sends. No promotional or
 * comparative words, and no delivery date is promised, since USPS First-Class
 * Mail guarantees none.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import {
  addressRequestLinkDays,
  isAddressRequestsEnabled
} from '../config/addressRequests.js';
import { isArriveByEnabled, scheduleHorizonDays, scheduleLeadDays } from '../config/arriveBy.js';
import { isCertifiedMailOffered } from '../config/certifiedMail.js';
import { isCustomStationeryOffered } from '../config/customStationery.js';
import { isPostcardCollagesOffered } from '../config/postcardCollages.js';
import { isPostcardLayoutsOffered } from '../config/postcardLayouts.js';
import { isPostcardSizesOffered, offeredPostcardSizes } from '../config/postcardSizes.js';
import {
  formatAmountForCurrency,
  isJitProductSold,
  isJitPurchaseEnabled,
  jitCurrency,
  JIT_PRODUCTS,
  packCurrency,
  PACK_PRODUCTS,
  type JitProductDefinition
} from '../config/products.js';
import { isRoomToWriteOffered, letterPageLimit } from '../config/roomToWrite.js';
import { isSendConfirmationEnabled, letterPacksPageUrl, websiteBaseUrl } from '../config/sendConfirmation.js';
import { isSignaturesOffered } from '../config/signatures.js';
import { isStationeryOffered } from '../config/stationery.js';
import {
  CERTIFIED_DELIVERY_CLASS,
  CERTIFIED_DELIVERY_DISCLAIMER,
  CERTIFIED_RECEIPT_DELIVERY_CLASS,
  DELIVERY_CLASS,
  DELIVERY_DISCLAIMER,
  DELIVERY_ESTIMATE
} from '../content/delivery.js';
import { STATIONERY_THEMES } from '../render/stationery.js';
import { COLLAGE_MAX_PHOTOS, COLLAGE_MIN_PHOTOS } from '../services/collageArrangement.js';
import { MAX_STATIONERY_DESIGNS } from '../services/stationeryDesignService.js';
import type { PostcardSize } from '../services/types.js';

export const CAPABILITIES_PATH = '/capabilities.json';

/** Raised only when a field changes meaning or is removed; added fields keep it. */
export const CAPABILITIES_SCHEMA_VERSION = 1;

/** How long a client or cache may keep a copy. A price or switch change shows within this. */
export const CAPABILITIES_MAX_AGE_SECONDS = 300;

export interface Price {
  /** In the currency's minor unit: cents for usd. */
  readonly amountMinor: number;
  /** ISO 4217, lower case, as Stripe writes it. */
  readonly currency: string;
  /** The amount in major units, "4.99". */
  readonly display: string;
}

export interface Pack {
  readonly name: string;
  readonly description: string;
  /** Prepaid letters: each pays for one standard one-page letter or one 6x9 postcard. */
  readonly letters: number;
  readonly price: Price;
}

export type MailServiceName = 'standard' | 'certified' | 'certified_return_receipt';

export interface PayAndSendPrice {
  readonly mailType: 'letter' | 'postcard';
  /** Letters, standard service: the printed pages. A certified letter is one price whatever its pages. */
  readonly pages?: number;
  /** Postcards: the size as a person names it, "4x6", "6x9" or "11x6". */
  readonly size?: string;
  /** Letters: how the letter travels. */
  readonly mailService?: MailServiceName;
  readonly description: string;
  readonly price: Price;
}

export interface MailOption {
  readonly name: string;
  readonly description: string;
}

export interface MailKind {
  readonly kind: 'letter' | 'postcard';
  readonly description: string;
  /** Only the options this deployment offers. */
  readonly options: readonly MailOption[];
}

export interface Limit {
  readonly name: string;
  readonly description: string;
  readonly value?: number;
  readonly unit?: string;
}

export interface CapabilitiesDocument {
  readonly schemaVersion: number;
  readonly name: string;
  readonly summary: string;
  readonly website: string;
  /** The MCP endpoint an assistant connects to, signed in with OAuth. */
  readonly mcpServer: string;
  readonly sending: { readonly whoSends: string; readonly previews: string };
  readonly mail: readonly MailKind[];
  readonly pricing: {
    readonly packs: {
      readonly description: string;
      readonly buyAt: string;
      readonly items: readonly Pack[];
    };
    /** Absent while this deployment does not sell Pay & Send. */
    readonly payAndSend?: {
      readonly description: string;
      readonly items: readonly PayAndSendPrice[];
    };
  };
  readonly delivery: {
    readonly mailClass: string;
    readonly estimate: string;
    readonly note: string;
    readonly certified?: { readonly mailClasses: readonly string[]; readonly note: string };
    readonly arriveBy?: { readonly description: string; readonly maxDaysAhead: number; readonly leadBusinessDays: number };
  };
  readonly limits: readonly Limit[];
}

export interface CapabilitiesUrls {
  /** The MCP endpoint's full URL. */
  readonly mcpServer: string;
}

/** Each size as a person names it (the short side last), and its inches. */
const POSTCARD_SIZE_NAMES: Readonly<Record<PostcardSize, { name: string; inches: string }>> = {
  '6x9': { name: '6x9', inches: '9 x 6 in' },
  '6x4': { name: '4x6', inches: '6 x 4 in' },
  '6x11': { name: '11x6', inches: '11 x 6 in' }
};

function priceOf(amountMinor: number, currency: string): Price {
  return { amountMinor, currency, display: formatAmountForCurrency(amountMinor, currency) };
}

/**
 * Whether the option a Pay & Send product pays for is offered here: its flag
 * is on (isJitProductSold) and the previews take the option, which may need
 * more than the flag (our renderer, Pay & Send itself). A product sold for an
 * option no preview offers is a price nobody can reach, so it is left out.
 */
export function isPayAndSendPriceOffered(product: JitProductDefinition, env: NodeJS.ProcessEnv): boolean {
  if (!isJitPurchaseEnabled(env) || !isJitProductSold(product, env)) return false;
  if (product.mailService !== undefined) return isCertifiedMailOffered(env);
  if (product.mailType === 'letter') return (product.pages ?? 1) === 1 || isRoomToWriteOffered(env);
  return offeredPostcardSizes(env).includes(product.postcardSize ?? '6x9');
}

function payAndSendDescription(product: JitProductDefinition, env: NodeJS.ProcessEnv): string {
  if (product.mailType === 'postcard') {
    const size = POSTCARD_SIZE_NAMES[product.postcardSize ?? '6x9'];
    return `One ${size.name} postcard (${size.inches})`;
  }
  if (product.mailService !== undefined) {
    // One price whatever the pages, up to the most a letter may take here.
    const limit = letterPageLimit(env);
    const letter = limit === 1 ? 'One one-page letter' : `One letter of one to ${limit} pages`;
    const mailClass = product.mailService === 'certified_return_receipt' ? CERTIFIED_RECEIPT_DELIVERY_CLASS : CERTIFIED_DELIVERY_CLASS;
    return `${letter}, sent as ${mailClass}`;
  }
  const pages = product.pages ?? 1;
  return pages === 1 ? 'One one-page letter' : `One letter of ${pages} pages`;
}

function payAndSendPrice(product: JitProductDefinition, currency: string, env: NodeJS.ProcessEnv): PayAndSendPrice {
  const shape =
    product.mailType === 'postcard'
      ? { size: POSTCARD_SIZE_NAMES[product.postcardSize ?? '6x9'].name }
      : product.mailService !== undefined
        ? { mailService: product.mailService }
        : { pages: product.pages ?? 1, mailService: 'standard' as const };
  return {
    mailType: product.mailType === 'postcard' ? 'postcard' : 'letter',
    ...shape,
    description: payAndSendDescription(product, env),
    price: priceOf(product.expectedAmountCents, currency)
  };
}

/**
 * What Pay & Send is, and which offered options only it pays for (#579):
 * named only while offered, so a deployment never names an option it does not sell.
 */
function payAndSendSummary(env: NodeJS.ProcessEnv): string {
  const only = [
    ...(isRoomToWriteOffered(env) ? ['a letter of more than one page'] : []),
    ...(isPostcardSizesOffered(env) ? ['a 4x6 or 11x6 postcard'] : []),
    ...(isCertifiedMailOffered(env) ? ['certified mail'] : [])
  ];
  const sentence = 'Pay at checkout for one piece of mail when it is sent.';
  if (only.length === 0) return sentence;
  const list = only.length === 1 ? only[0] : `${only.slice(0, -1).join(', ')} and ${only[only.length - 1]}`;
  return `${sentence} ${list.charAt(0).toUpperCase()}${list.slice(1)} ${only.length === 1 ? 'is' : 'are'} paid only this way.`;
}

function whoSends(env: NodeJS.ProcessEnv): string {
  return isSendConfirmationEnabled(env)
    ? 'A person sends each piece of mail. Where the assistant shows the Letter IRL preview card, they press Send on it; ' +
        'elsewhere the assistant gives them a link to the Letter IRL website, where they sign in, check the mail and press Send. ' +
        'An assistant prepares previews but cannot send mail by itself.'
    : 'The assistant sends a piece of mail only after the person has checked its preview and confirmed sending in the conversation.';
}

function letterOptions(env: NodeJS.ProcessEnv): MailOption[] {
  const options: MailOption[] = [
    { name: 'Image', description: 'A picture at the top of the letter, or after the signature.' }
  ];
  if (isRoomToWriteOffered(env)) {
    options.push({
      name: 'More pages',
      description: `Up to ${letterPageLimit(env)} pages. Past the first page, the paper is printed on both sides.`
    });
  }
  if (isStationeryOffered(env)) {
    options.push({
      name: 'Stationery',
      description: `A style for the letter: ${STATIONERY_THEMES.join(', ')}. Classic is a plain page.`
    });
  }
  if (isCustomStationeryOffered(env)) {
    options.push({
      name: 'Saved stationery designs',
      description: `Stationery designs a person saves to their account, up to ${MAX_STATIONERY_DESIGNS}.`
    });
  }
  if (isSignaturesOffered(env)) {
    options.push({
      name: 'Signature',
      description: "The person's saved signature, from a photo, printed under the closing."
    });
  }
  if (isCertifiedMailOffered(env)) {
    options.push({
      name: 'Certified mail',
      description: `Sent as ${CERTIFIED_DELIVERY_CLASS}, with or without an electronic return receipt, and signed for at delivery.`
    });
  }
  return options;
}

function postcardOptions(env: NodeJS.ProcessEnv): MailOption[] {
  const options: MailOption[] = [];
  if (isPostcardSizesOffered(env)) {
    const sizes = offeredPostcardSizes(env).map(size => `${POSTCARD_SIZE_NAMES[size].name} (${POSTCARD_SIZE_NAMES[size].inches})`);
    options.push({ name: 'Size', description: `${sizes.join(', ')}. Without a choice, a postcard is 6x9.` });
  }
  if (isPostcardLayoutsOffered(env)) {
    options.push({
      name: 'Front layout',
      description: 'The photo across the whole front, the photo in a white border with a caption, or "Greetings from" a place over the photo.'
    });
  }
  if (isPostcardCollagesOffered(env)) {
    options.push({
      name: 'Collage',
      description: `${COLLAGE_MIN_PHOTOS} to ${COLLAGE_MAX_PHOTOS} photos arranged on the front.`
    });
  }
  return options;
}

function limitsOf(env: NodeJS.ProcessEnv): Limit[] {
  const limits: Limit[] = [
    {
      name: 'Addresses',
      description: 'The recipient and the return address must both be in the United States. Each piece of mail goes to one recipient.'
    },
    {
      name: 'Letter length',
      description: 'The most pages a letter may take. The words must fit on them; the preview lays the letter out and says when it does not fit.',
      value: letterPageLimit(env),
      unit: 'pages'
    },
    {
      name: 'Postcard message',
      description: 'The message must fit on the back of the postcard beside the address. The preview says when it does not fit.'
    }
  ];
  if (isAddressRequestsEnabled(env)) {
    limits.push({
      name: 'Address requests',
      description:
        'How long a private address request link works. A person who lacks an address can share one for the recipient to give a U.S. address on the Letter IRL website.',
      value: addressRequestLinkDays(env),
      unit: 'days'
    });
  }
  return limits;
}

/** The document, for this deployment's settings. Pure in `env`, so a test can read every combination. */
export function buildCapabilities(env: NodeJS.ProcessEnv, urls: CapabilitiesUrls): CapabilitiesDocument {
  const packCcy = packCurrency(env);
  const jitCcy = jitCurrency(env);
  const payAndSend = isJitPurchaseEnabled(env)
    ? JIT_PRODUCTS.filter(product => isPayAndSendPriceOffered(product, env)).map(product => payAndSendPrice(product, jitCcy, env))
    : [];

  const certified = isCertifiedMailOffered(env);
  const arriveBy = isArriveByEnabled(env);

  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    name: 'Letter IRL',
    summary:
      'Letter IRL prints physical letters and postcards and mails them with USPS to addresses in the United States. ' +
      'A person writes the mail with an AI assistant connected to Letter IRL, checks a preview, and sends it.',
    website: websiteBaseUrl(env),
    mcpServer: urls.mcpServer,
    sending: {
      whoSends: whoSends(env),
      previews: 'A preview is free. It shows the mail as it will print, and its price. Nothing is printed or charged until the mail is sent.'
    },
    mail: [
      {
        kind: 'letter',
        description:
          'A letter printed on 8.5 x 11 in paper and mailed in an envelope. The addresses print at the top of the first page.',
        options: letterOptions(env)
      },
      {
        kind: 'postcard',
        description: 'A postcard with a photo on the front and the message and address on the back.',
        options: postcardOptions(env)
      }
    ],
    pricing: {
      packs: {
        description:
          'Prepaid letters, bought at checkout. Each prepaid letter pays for one one-page letter or one 6x9 postcard sent by standard mail.',
        buyAt: letterPacksPageUrl(env),
        items: PACK_PRODUCTS.map(pack => ({
          name: pack.name,
          description: pack.description,
          letters: pack.letters,
          price: priceOf(pack.expectedAmountCents, packCcy)
        }))
      },
      ...(payAndSend.length > 0
        ? {
            payAndSend: {
              description: payAndSendSummary(env),
              items: payAndSend
            }
          }
        : {})
    },
    delivery: {
      mailClass: DELIVERY_CLASS,
      estimate: `${DELIVERY_ESTIMATE}.`,
      note: `${DELIVERY_DISCLAIMER} USPS does not guarantee a delivery date for First-Class Mail.`,
      ...(certified
        ? {
            certified: {
              mailClasses: [CERTIFIED_DELIVERY_CLASS, CERTIFIED_RECEIPT_DELIVERY_CLASS],
              note: CERTIFIED_DELIVERY_DISCLAIMER
            }
          }
        : {}),
      ...(arriveBy
        ? {
            arriveBy: {
              description:
                'A person may give the date the mail should arrive by. Letter IRL holds the mail and sends it to the printer ' +
                'early enough that it aims to arrive by then; the date is a target, not a guarantee.',
              maxDaysAhead: scheduleHorizonDays(env),
              leadBusinessDays: scheduleLeadDays(env)
            }
          }
        : {})
    },
    limits: limitsOf(env)
  };
}

/**
 * Answers GET and HEAD at CAPABILITIES_PATH. Public: no credentials are read,
 * and nothing in the body depends on who asks.
 */
export function handleCapabilitiesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  urls: CapabilitiesUrls,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const body = JSON.stringify(buildCapabilities(env, urls), null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=${CAPABILITIES_MAX_AGE_SECONDS}`,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * What the server knows of each tool beyond its definition, in one place (#687): whether this deployment offers it
 * to the calling app, whether only a card may call it, which input fields it is served without, and which result
 * fields are for a card and never the model's.
 *
 * These lived in four places: the listing's filters (src/server.ts), the card-only sets and withheld fields
 * (src/mcp/registerTools.ts), and the hand list in partitionToolResult with its type-level copy
 * (src/contracts/outputConformance.ts). The listing, the registration, the result partition and the manifest now
 * all read this. Every tool the server defines has an entry (getToolCatalogEntry throws for one that does not),
 * and tests/unit/mcp/servedToolsSnapshot.test.ts holds what is served to what it was.
 */

import type { ClientProfile } from "../auth/clientProfiles.js";
import { isAddressRequestsEnabled } from "../config/addressRequests.js";
import { isArriveByEnabled } from "../config/arriveBy.js";
import { isCardUploadEnabled } from "../config/cardUpload.js";
import { isCertifiedMailOffered } from "../config/certifiedMail.js";
import { isCustomStationeryOffered } from "../config/customStationery.js";
import { offersImageGeneration } from "../config/imageGeneration.js";
import { isLetterHomeEnabled } from "../config/letterHome.js";
import { isPostcardCollagesOffered } from "../config/postcardCollages.js";
import { isPostcardLayoutsOffered } from "../config/postcardLayouts.js";
import { isPostcardSizesOffered } from "../config/postcardSizes.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";
import { isSignaturesOffered } from "../config/signatures.js";
import { isStationeryOffered } from "../config/stationery.js";
import { isWordsEditorOffered } from "../config/wordsEditor.js";

export interface ToolCatalogEntry {
  /**
   * Whether this deployment lists the tool for this app, as it stands now: its flags, and what the app allows (it
   * takes purchases, it may generate images). Absent: always. A tool not listed may still be reached by execute():
   * request_send answers a send from an app without our card.
   */
  readonly offered?: (client: ClientProfile) => boolean;
  /**
   * A tool that sends (#470): card-only while the send rule is on, so the card's Send and Pay & Send buttons can
   * call it and the model cannot. Pay & Send joined the sends for launch (#475).
   */
  readonly cardOnlySend?: true;
  /**
   * A tool only a card asks, whatever the send rule (#474): hidden from the model, callable by the card. It needs no
   * person to press anything, so unlike a send it is only hidden.
   */
  readonly appOnly?: true;
  /**
   * The input fields the tool is served without while their feature is off. tools/list (getServedInputSchema) and
   * /manifest.json both ask this, so they agree. A caller still holding the wider schema is refused by the tool.
   */
  readonly withheldInputKeys?: () => readonly string[];
}

/** The letter previews' stationery arguments (#563). */
export const STATIONERY_INPUT_KEYS: readonly string[] = ["stationery", "monogram", "headline"];

/** The postcard preview's front arguments (#594). */
export const POSTCARD_FRONT_INPUT_KEYS: readonly string[] = ["layout", "caption", "place"];

/** The postcard preview's collage photos (#616). */
export const POSTCARD_COLLAGE_INPUT_KEYS: readonly string[] = ["images", "imageUrls"];

/**
 * A letter preview's withheld fields: its arrival date while arrive-by is off (#535), its stationery while that is
 * not offered (#563), a saved design while designs are not (#649; set_stationery is served as before them instead,
 * servesStationeryThemeOnly), its signature while signatures are not (#608), and its mail service while certified
 * mail is not (#625).
 */
function letterPreviewWithheld(): string[] {
  const withheld: string[] = [];
  if (!isArriveByEnabled()) withheld.push("arriveBy");
  if (!isStationeryOffered()) withheld.push(...STATIONERY_INPUT_KEYS);
  if (!isCustomStationeryOffered()) withheld.push("stationeryDesignId");
  if (!isSignaturesOffered()) withheld.push("signature");
  if (!isCertifiedMailOffered()) withheld.push("mailService");
  return withheld;
}

/** The postcard preview's: its arrival date, its front while the layouts are not offered (#594), its collage photos while collages are not (#616). */
function postcardPreviewWithheld(): string[] {
  const withheld: string[] = [];
  if (!isArriveByEnabled()) withheld.push("arriveBy");
  if (!isPostcardLayoutsOffered()) withheld.push(...POSTCARD_FRONT_INPUT_KEYS);
  if (!isPostcardCollagesOffered()) withheld.push(...POSTCARD_COLLAGE_INPUT_KEYS);
  return withheld;
}

/** set_postcard_style takes each only while it is offered (#594): the size while the sizes are, the front while the layouts are. */
function postcardStyleWithheld(): string[] {
  const withheld: string[] = [];
  if (!isPostcardSizesOffered()) withheld.push("size");
  if (!isPostcardLayoutsOffered()) withheld.push(...POSTCARD_FRONT_INPUT_KEYS);
  return withheld;
}

/**
 * The checkouts: listed only where the app takes purchases (#475). Claude allows no purchases through connectors,
 * and the Connectors Directory takes no connector that executes financial transactions; there, letters are bought
 * on the website, which get_started, get_account_balance and list_letter_packs link to.
 */
const takesPurchases = (client: ClientProfile) => client.inAppPurchases;

const LETTER_PREVIEW: ToolCatalogEntry = { withheldInputKeys: letterPreviewWithheld };
const addressRequests = () => isAddressRequestsEnabled();
const signatures = () => isSignaturesOffered();
const designs = () => isCustomStationeryOffered();

export const TOOL_CATALOG: Readonly<Record<string, ToolCatalogEntry>> = {
  // Letter IRL home: listed only while LETTER_IRL_HOME_ENABLED is on.
  open_letter_home: { offered: () => isLetterHomeEnabled() },
  quote_and_preview_letter: LETTER_PREVIEW,
  quote_and_preview_letter_with_header_image: LETTER_PREVIEW,
  quote_and_preview_letter_with_image: LETTER_PREVIEW,
  send_letter: { cardOnlySend: true },
  // Pay & Send: card-only like the sends, and listed only where the app takes purchases.
  create_mail_checkout: { cardOnlySend: true, offered: takesPurchases },
  create_pack_checkout: { offered: takesPurchases },
  list_letter_packs: {},
  redeem_promo_code: {},
  get_purchase_status: {},
  get_order_status: {},
  get_account_balance: {},
  list_orders: {},
  quote_and_preview_postcard: { withheldInputKeys: postcardPreviewWithheld },
  send_postcard: { cardOnlySend: true },
  // A preview's arrival date and held mail's cancel (#535): while arrival dates are on.
  set_arrival_date: { offered: () => isArriveByEnabled() },
  cancel_scheduled_mail: { offered: () => isArriveByEnabled() },
  // While stationery is offered (#563).
  set_stationery: { offered: () => isStationeryOffered() },
  // While certified mail is offered (#625).
  set_mail_service: { offered: () => isCertifiedMailOffered() },
  // While the words can be changed in place (room to write, #586, or the words editor, #647).
  set_letter_words: { offered: () => isWordsEditorOffered() },
  // While the postcard sizes or layouts are offered (#594).
  set_postcard_style: { offered: () => isPostcardSizesOffered() || isPostcardLayoutsOffered(), withheldInputKeys: postcardStyleWithheld },
  // Address requests (#604): while LETTER_IRL_ADDRESS_REQUESTS_ENABLED is on; each refuses otherwise.
  request_address: { offered: addressRequests },
  get_address_request: { offered: addressRequests },
  cancel_address_request: { offered: addressRequests },
  // A saved signature (#608): while signatures are offered; each refuses otherwise.
  set_signature: { offered: signatures },
  get_signature: { offered: signatures },
  clear_signature: { offered: signatures },
  set_letter_signature: { offered: signatures },
  // Saved stationery designs (#649): while designs are offered; each refuses otherwise.
  save_stationery_design: { offered: designs },
  list_stationery_designs: { offered: designs },
  delete_stationery_design: { offered: designs },
  // The preview card asks what became of its draft (#474).
  get_draft_status: { appOnly: true },
  // The send rule's link (#470), which ships with the confirmation page: listed only while the rule is on.
  request_send: { offered: () => isSendConfirmationEnabled() },
  // Letter IRL's AI image generation: where the app allows it and the switch is not off (#467).
  generate_image_for_mail: { offered: client => offersImageGeneration(client) },
  set_return_address: {},
  get_return_address: {},
  clear_return_address: {},
  submit_feature_request: {},
  get_profile: {},
  get_started: {},
  upload_image: {},
  confirm_uploaded_image: {},
  // The upload card's photo (#474, phase 3): card-only, and listed only while card uploads are on.
  upload_photo_chunk: { appOnly: true, offered: () => isCardUploadEnabled() }
};

/** A tool's entry. A tool without one is a tool this file was not told of: an error, not a tool served by default. */
export function getToolCatalogEntry(name: string): ToolCatalogEntry {
  // Own entries only: "toString" is not a tool.
  const entry = Object.hasOwn(TOOL_CATALOG, name) ? TOOL_CATALOG[name] : undefined;
  if (!entry) throw new Error(`Tool ${name} has no entry in src/mcp/toolCatalog.ts`);
  return entry;
}

/** Whether this deployment lists the tool for this app now. */
export function isToolOffered(name: string, client: ClientProfile): boolean {
  const offered = getToolCatalogEntry(name).offered;
  return offered ? offered(client) : true;
}

/** The tools that send, which the send rule makes card-only (#470). */
export const CARD_ONLY_SEND_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_CATALOG).filter(([, entry]) => entry.cardOnlySend).map(([name]) => name)
);

/** The tools only a card asks, whatever the send rule (#474). */
export const APP_ONLY_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_CATALOG).filter(([, entry]) => entry.appOnly).map(([name]) => name)
);

/** The input fields a tool is served without, as this deployment stands. */
export function withheldInputKeys(name: string): string[] {
  const withheld = Object.hasOwn(TOOL_CATALOG, name) ? TOOL_CATALOG[name].withheldInputKeys : undefined;
  return withheld ? [...withheld()] : [];
}

/**
 * Result fields for a card, never the model's (partitionToolResult), and what becomes of each:
 * - "meta": moved to _meta for the card;
 * - "copy": moved to _meta, and kept in structuredContent too where the app is not proven to hand a card the
 *   result's _meta (#474), or the card could have nothing to show;
 * - "drop": a full-quality original the draft already holds, dropped from both.
 *
 * The order is the order they reach _meta. A field a tool produces that its served output schema does not declare
 * must be one of these, or ChatGPT drops it (src/contracts/outputConformance.ts reads this table's keys).
 */
export const CARD_RESULT_FIELDS = {
  previewHtml: "meta",
  previewFrontHtml: "meta",
  previewBackHtml: "meta",
  // get_started's card copy. Display-only: when the model could see it, it restated the whole card in prose
  // directly beneath a card already showing it.
  title: "copy",
  overview: "copy",
  purchaseStep: "copy",
  examplePrompts: "copy",
  // The letter card's images, compressed to roughly 3KB for this trip, so forwarded rather than dropped.
  headerImagePreview: "meta",
  inlineImagePreview: "meta",
  generatedImagePreview: "meta",
  // How full a letter's pages are (#586), for the card's fit line.
  pageFit: "meta",
  // A saved signature's picture (#608): the model reads its sentence.
  signatureImage: "meta",
  // The services a letter card's Delivery tab offers (#648): the model changes one with set_mail_service.
  mailServices: "meta",
  // The account's saved designs for a letter card's Style row (#649): the model lists them itself.
  stationeryDesigns: "meta",
  // The full-quality originals, which the draft holds.
  inlineImageData: "drop",
  headerImageData: "drop",
  frontImageData: "drop"
} as const;

export type CardResultField = keyof typeof CARD_RESULT_FIELDS;

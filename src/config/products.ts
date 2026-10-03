import { createHash } from 'node:crypto';
/**
 * The product table: every sellable product, its identity, where its Stripe
 * price id comes from, and THE AMOUNT IT IS EXPECTED TO COST. A leaf module
 * (no src/ imports beyond types and the leaf flag reader), so the config
 * layer, the price catalog, the Stripe service, and the reconciliation service
 * can all read the SAME table.
 *
 * Before this existed the table was copied by hand in three places -
 * PACK_PRODUCTS in stripeService, PACK_PRICE_VARS/JIT_VARS in deploymentConfig,
 * and PRODUCT_CREDITS in stripeReconciliationService (whose comment literally
 * said "must match stripeService.ts") - which is the drift shape behind #160,
 * #270, and #275: lists that must agree, with nothing comparing them.
 *
 * WHY expectedAmountCents EXISTS - the two-source design (#278, five review
 * rounds). Stripe's Price object is what the customer is charged; this table
 * is what the business AGREED to charge. The catalog refuses to sell any
 * product whose resolved Price disagrees with its pinned amount, which is the
 * only kind of check that can catch a wrong-but-plausible price id: transposed
 * env vars, an id pasted from the wrong product, a repoint to an unrelated
 * Price - every one of these passes any per-price validation (active,
 * one-time, in some sane range) because the price it points at is a perfectly
 * healthy price, just not THIS product's. #275 originally deleted the old
 * env-var amounts as "a second copy that can drift"; review proved the second
 * copy was load-bearing - it was the only two-source agreement test on the
 * money path - and that its real defect was WHERE it lived (five env values
 * across two Railway environments), not THAT it existed. One reviewed line
 * per product in version control is a different beast.
 *
 * CHANGING A PRICE: create the new Price in Stripe (amounts are immutable on
 * an existing Price), then in ONE commit update expectedAmountCents here and
 * point the STRIPE_PRICE_* / STRIPE_JIT_*_PRICE_ID env var at the new id.
 * A redeploy was already required (the id is an env var), so this adds no
 * operational step - it adds a review.
 */

import type { CertifiedMailService, MailService, MailType, PostcardSize } from '../services/types.js';
import { offUnlessExplicitlyEnabled } from '../utils/envSettings.js';

/**
 * The flags that sell the mail options added after the one-page letter and the
 * 6x9 postcard (#578). Each also switches its option on (room to write, the
 * postcard sizes, certified mail), so an option is never sold without its
 * price, nor priced without being sold. Off unless set: production waits for
 * the owner's word.
 */
export const ROOM_TO_WRITE_FLAG = 'LETTER_IRL_ROOM_TO_WRITE_ENABLED';
export const POSTCARD_SIZES_FLAG = 'LETTER_IRL_POSTCARD_SIZES_ENABLED';
export const CERTIFIED_MAIL_FLAG = 'LETTER_IRL_CERTIFIED_MAIL_ENABLED';

/**
 * What a Pay & Send price depends on: the mail type, a letter's printed pages,
 * a postcard's size and how a letter travels. Pages default to one, the size to
 * 6x9 and the service to standard, the only mail sold before #578.
 */
export interface MailOption {
  readonly mailType: MailType;
  readonly pages?: number;
  readonly postcardSize?: PostcardSize;
  /** Absent is standard. Only a letter is ever certified (#625). */
  readonly mailService?: MailService;
}

/**
 * The mail option a draft is, from its row: its mail type, a letter's printed
 * pages (migration 047, #586) and a postcard's size. Here, beside the option,
 * so the send, the checkout and the confirmation page read it alike: a reader
 * that loads only part of the row must load `pages` too, or a long letter is
 * priced as one page.
 */
export function draftMailOption(draft: {
  mail_type?: string | null;
  postcard_size?: string | null;
  pages?: number | string | null;
  mail_service?: string | null;
}): MailOption {
  const mailType = (draft.mail_type || 'letter') as MailType;
  if (mailType === 'postcard') return { mailType, postcardSize: (draft.postcard_size || '6x9') as PostcardSize };
  // A SMALLINT comes back from pg as a number; anything else is read as its number.
  const pages = Number(draft.pages ?? 1);
  // The column holds only these three values (a CHECK, #625); a reader that
  // loads only part of the row must load `mail_service` too, or a certified
  // letter is priced as a standard one.
  const mailService = mailServiceOf(draft.mail_service);
  return {
    mailType,
    ...(pages > 1 ? { pages } : {}),
    ...(mailService ? { mailService } : {})
  };
}

/**
 * The service a stored value (a draft's mail_service) names, as a MailOption
 * carries it: absent for standard, null and the empty string; the certified
 * services as they are; and any OTHER text as itself, so that it fails closed
 * everywhere downstream (no product matches it, no pack or gift pays for it)
 * rather than being priced and mailed as standard. The column's CHECK keeps
 * one from existing; this holds if the code is ever older than the data.
 */
export function mailServiceOf(value: string | null | undefined): MailService | undefined {
  if (value === null || value === undefined || value === '' || value === 'standard') return undefined;
  return value as MailService;
}

/**
 * Internal credits per customer-facing letter.
 *
 * Credits are the ledger unit; letters are the only unit a customer sees. The
 * conversion was written out separately at each site that needed it, so this
 * is the shared source rather than letting a new site become a fourth copy.
 *
 * The property this ratio underwrites - that comparing letters gives the same
 * verdict as comparing credits - holds only while pricing is flat, and is
 * pinned by tests/unit/tools/letterBalanceEquivalence.test.ts.
 */
export const CREDITS_PER_LETTER = 2;

/**
 * Customer-facing pack names, mapped to internal product codes.
 *
 * The catalogue names its products after CREDITS - 'credit-pack-4' is two
 * letters - and these names reach the model through tool schemas, so exposing
 * the raw codes would put the word in conversation and misstate the quantity by
 * a factor of two. Lives here rather than in a tool because more than one tool
 * needs it, and two copies of this table is the drift this repository keeps
 * producing.
 */
export const PACK_CHOICES = {
  starter: 'credit-pack-4',
  regular: 'credit-pack-10',
  power: 'credit-pack-100'
} as const;

export type PackChoice = keyof typeof PACK_CHOICES;

export type PackProductId = 'credit-pack-4' | 'credit-pack-10' | 'credit-pack-100';
export type ProductGroup = 'pack' | 'jit';

export interface PackProductDefinition {
  readonly productCode: PackProductId;
  readonly credits: number;
  /**
   * What the customer is buying, in the unit they see. Credits are internal
   * (2 per letter) and productCode is named after them, so without this the
   * only customer-facing count lives inside the display name. First-class
   * here so no caller has to divide by two - see
   * tests/unit/tools/letterBalanceEquivalence.test.ts for why that division
   * is load-bearing.
   */
  readonly letters: number;
  readonly priceEnv: string;
  /**
   * The amount this product is agreed to cost, in minor units of the store
   * currency. The configured Stripe Price MUST resolve to exactly this figure
   * or the catalog refuses to sell the product.
   */
  readonly expectedAmountCents: number;
  readonly name: string;
  readonly description: string;
  /**
   * Gift letters granted with the pack when gift letters are enabled, and the
   * budget each carries: how many further funded cards may follow it. A
   * budget of 1 means the pack's gift letter prints a code, and the letter
   * that code grants prints the plain card. See docs/gift-letters.md for the
   * cost bound this sets per pack.
   */
  readonly giftLetters: number;
  readonly giftGenerationsRemaining: number;
}

export type JitProductCode =
  | 'jit-letter'
  | 'jit-postcard'
  | 'jit-letter-2-pages'
  | 'jit-letter-3-pages'
  | 'jit-postcard-4x6'
  | 'jit-postcard-11x6'
  | 'jit-letter-certified'
  | 'jit-letter-certified-receipt';

export interface JitProductDefinition {
  readonly productCode: JitProductCode;
  readonly mailType: MailType;
  /** Letters: the pages printed, double-sided past the first. */
  readonly pages?: number;
  /** Postcards: the size, in PostGrid's terms ('6x4' is the 4x6, '6x11' the 11x6). */
  readonly postcardSize?: PostcardSize;
  /**
   * Letters: the extra service it sells (#625). Its price is flat, whatever the
   * pages (one to three, held by the preview), so it has no `pages`.
   */
  readonly mailService?: CertifiedMailService;
  /**
   * The flag that sells it (#578). The two products sold before have none and
   * are sold whenever Pay & Send is.
   */
  readonly enabledBy?: string;
  readonly priceEnv: string;
  /** See PackProductDefinition.expectedAmountCents; units are the JIT currency's. */
  readonly expectedAmountCents: number;
  readonly name: string;
  readonly description: string;
}

export const PACK_PRODUCTS: readonly PackProductDefinition[] = [
  {
    productCode: 'credit-pack-4',
    credits: 4,
    letters: 2,
    priceEnv: 'STRIPE_PRICE_STARTER',
    expectedAmountCents: 500,
    name: 'Starter Pack - 2 Letters',
    description: 'Two prepaid physical letters or postcards',
    giftLetters: 1,
    giftGenerationsRemaining: 1
  },
  {
    productCode: 'credit-pack-10',
    credits: 10,
    letters: 5,
    priceEnv: 'STRIPE_PRICE_REGULAR',
    expectedAmountCents: 1000,
    name: 'Regular Pack - 5 Letters',
    description: 'Five prepaid physical letters or postcards',
    giftLetters: 1,
    giftGenerationsRemaining: 1
  },
  {
    productCode: 'credit-pack-100',
    credits: 100,
    letters: 50,
    priceEnv: 'STRIPE_PRICE_POWER',
    expectedAmountCents: 9000,
    name: 'Power Pack - 50 Letters',
    description: 'Fifty prepaid physical letters or postcards',
    giftLetters: 1,
    giftGenerationsRemaining: 1
  }
] as const;

export const JIT_PRODUCTS: readonly JitProductDefinition[] = [
  {
    productCode: 'jit-letter',
    mailType: 'letter',
    pages: 1,
    priceEnv: 'STRIPE_JIT_LETTER_PRICE_ID',
    expectedAmountCents: 499,
    name: 'Pay & Send One Physical Letter',
    description: 'Payment authorizes Letter IRL to print and mail this exact letter.'
  },
  {
    // The letter and postcard are pinned at the SAME amount today, which is
    // what makes sharing one Stripe Price between them legitimate - the
    // amount check permits sharing exactly when the pinned amounts agree.
    productCode: 'jit-postcard',
    mailType: 'postcard',
    postcardSize: '6x9',
    priceEnv: 'STRIPE_JIT_POSTCARD_PRICE_ID',
    expectedAmountCents: 499,
    name: 'Pay & Send One Physical Postcard',
    description: 'Payment authorizes Letter IRL to print and mail this exact postcard.'
  },
  // The options' prices are the proposal on epic #537 (#578), in development
  // until the owner approves them. Packs and gift letters never pay for these
  // options (#579), so each is sold only through Pay & Send, at its own price.
  {
    productCode: 'jit-letter-2-pages',
    mailType: 'letter',
    pages: 2,
    enabledBy: ROOM_TO_WRITE_FLAG,
    priceEnv: 'STRIPE_JIT_LETTER_TWO_PAGES_PRICE_ID',
    expectedAmountCents: 599,
    name: 'Pay & Send One Two-Page Letter',
    description: 'Payment authorizes Letter IRL to print and mail this exact two-page letter.'
  },
  {
    productCode: 'jit-letter-3-pages',
    mailType: 'letter',
    pages: 3,
    enabledBy: ROOM_TO_WRITE_FLAG,
    priceEnv: 'STRIPE_JIT_LETTER_THREE_PAGES_PRICE_ID',
    expectedAmountCents: 699,
    name: 'Pay & Send One Three-Page Letter',
    description: 'Payment authorizes Letter IRL to print and mail this exact three-page letter.'
  },
  {
    productCode: 'jit-postcard-4x6',
    mailType: 'postcard',
    postcardSize: '6x4',
    enabledBy: POSTCARD_SIZES_FLAG,
    priceEnv: 'STRIPE_JIT_POSTCARD_4X6_PRICE_ID',
    expectedAmountCents: 399,
    name: 'Pay & Send One 4x6 Postcard',
    description: 'Payment authorizes Letter IRL to print and mail this exact 4x6 postcard.'
  },
  {
    productCode: 'jit-postcard-11x6',
    mailType: 'postcard',
    postcardSize: '6x11',
    enabledBy: POSTCARD_SIZES_FLAG,
    priceEnv: 'STRIPE_JIT_POSTCARD_11X6_PRICE_ID',
    expectedAmountCents: 599,
    name: 'Pay & Send One 11x6 Postcard',
    description: 'Payment authorizes Letter IRL to print and mail this exact 11x6 postcard.'
  },
  // Certified mail (#625): PostGrid's `extraService`, on a letter of one to
  // three pages. The prices are the proposal on the issue (the owner's call):
  // PostGrid's public prices are $6.94 and $9.85. If those include the letter
  // these leave about $4.40 after Stripe's fee; if they are added to its cost
  // (PostGrid's older notes list certified as an add-on) about $3.30. To be
  // confirmed with PostGrid. In development until the owner approves them.
  {
    productCode: 'jit-letter-certified',
    mailType: 'letter',
    mailService: 'certified',
    enabledBy: CERTIFIED_MAIL_FLAG,
    priceEnv: 'STRIPE_JIT_LETTER_CERTIFIED_PRICE_ID',
    expectedAmountCents: 1199,
    name: 'Pay & Send One Certified Mail Letter',
    description: 'Payment authorizes Letter IRL to print and mail this exact letter as USPS Certified Mail.'
  },
  {
    productCode: 'jit-letter-certified-receipt',
    mailType: 'letter',
    mailService: 'certified_return_receipt',
    enabledBy: CERTIFIED_MAIL_FLAG,
    priceEnv: 'STRIPE_JIT_LETTER_CERTIFIED_RECEIPT_PRICE_ID',
    expectedAmountCents: 1499,
    name: 'Pay & Send One Certified Mail Letter with Return Receipt',
    description:
      'Payment authorizes Letter IRL to print and mail this exact letter as USPS Certified Mail with an electronic return receipt.'
  }
] as const;

/** Whether this deployment sells the Pay & Send product: its flag, if it has one, is on. */
export function isJitProductSold(
  product: Pick<JitProductDefinition, 'enabledBy'>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return !product.enabledBy || offUnlessExplicitlyEnabled(product.enabledBy, env);
}

/** Env-name lists for the deployment manifest and the cutover preflight. */
export const PACK_PRICE_ENV_VARS: readonly string[] = PACK_PRODUCTS.map(p => p.priceEnv);
/** The Pay & Send prices every deployment with Pay & Send needs. */
export const JIT_PRICE_ENV_VARS: readonly string[] = JIT_PRODUCTS
  .filter(p => !p.enabledBy)
  .map(p => p.priceEnv);
/** The options' prices, each needed only while its flag is on as well (#578). */
export const JIT_OPTION_PRICE_ENV_VARS: ReadonlyArray<{ readonly priceEnv: string; readonly flag: string }> =
  JIT_PRODUCTS.flatMap(p => (p.enabledBy ? [{ priceEnv: p.priceEnv, flag: p.enabledBy }] : []));

/** Credits per pack product - the reconciliation service's map, derived. */
export const PACK_CREDITS_BY_PRODUCT: Readonly<Record<string, number>> = Object.fromEntries(
  PACK_PRODUCTS.map(p => [p.productCode, p.credits])
);

export function isJitPurchaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JIT_PURCHASE_ENABLED === 'true';
}

export function normalizedCurrency(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed || fallback;
}

/** Packs are always priced in the store currency. */
export function packCurrency(env: NodeJS.ProcessEnv = process.env): string {
  return normalizedCurrency(env.STRIPE_CURRENCY, 'usd');
}

/** Pay & Send may carry its own currency; falls back to the store currency. */
export function jitCurrency(env: NodeJS.ProcessEnv = process.env): string {
  return normalizedCurrency(env.JIT_CURRENCY, packCurrency(env));
}

export interface ConfiguredProduct {
  /**
   * Non-reversible digest of the Stripe credential this row is read under -
   * never the credential. The key decides which Stripe ACCOUNT a price id
   * resolves against, so it is part of the configuration; carrying it on the
   * row is what keeps the catalog's signature a pure function of ONE
   * environment. Reading it from ambient process.env inside the signature
   * meant a caller-threaded env got its price ids from one environment and
   * its credential from another - the stitched verdict the threading exists
   * to make unrepresentable, reproduced by two round-11 angles (#278 r11).
   */
  readonly credential: string;
  readonly productCode: string;
  readonly group: ProductGroup;
  /** Empty string when the env var is unset - the catalog records that as a failure. */
  readonly priceId: string;
  /** The pinned amount the resolved Price must equal, in minor units. */
  readonly expectedAmountCents: number;
  readonly expectedCurrency: string;
}

/**
 * Every product this deployment sells, with the price id and currency each is
 * expected to resolve to. JIT products appear ONLY when Pay & Send is enabled,
 * mirroring the manifest's `when-jit-enabled` condition - a disabled feature's
 * stale or placeholder price id must not be resolved, and must never be able to
 * fail readiness (#278 review).
 */
export function credentialFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.STRIPE_SECRET_KEY ?? '').trim();
  if (!key) return 'unset';
  // sha256, this repo's convention for digesting a credential: the value is
  // load-bearing for CORRECTNESS, not just redaction - a collision between
  // the old and new key would leave the signature unchanged and resurrect
  // the cooldown-outlives-the-fix bug it exists to prevent (#278 round 11).
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * THE ConfiguredProduct construction. Four hand-rolled copies of this literal
 * stood here (two in the table builder, two in the single-product accessor),
 * and priceCatalog keys every staleness decision on those two functions
 * agreeing: configSignature and memoMatchesConfiguration read one, pruneStale
 * reads the other. A field added to one copy and missed in the other makes
 * the single-product and full-table encodings of the same row disagree, and
 * memos are then validated by one and pruned by the other - the asymmetry
 * that produced the round-6 bug (#278 round 9).
 */
function configuredRow(
  definition: { productCode: string; priceEnv: string; expectedAmountCents: number },
  group: ConfiguredProduct['group'],
  currency: string,
  env: NodeJS.ProcessEnv
): ConfiguredProduct {
  return {
    credential: credentialFingerprint(env),
    productCode: definition.productCode,
    group,
    priceId: (env[definition.priceEnv] ?? '').trim(),
    expectedAmountCents: definition.expectedAmountCents,
    expectedCurrency: currency
  };
}

/**
 * Whether a letter pack or a gift letter pays for this mail (#579): a one-page
 * standard letter, in any layout and stationery, or a 6x9 postcard, the mail
 * sold before the options. Everything else is paid per send through Pay & Send,
 * at its own price. An unknown mail type is a letter, as it is priced.
 */
export function isPackPayable(option: MailOption): boolean {
  // Certified mail costs the carrier far more than a letter: never a pack's
  // (#625). Nor is a service this code does not know.
  if ((option.mailService ?? 'standard') !== 'standard') return false;
  return option.mailType === 'postcard'
    ? (option.postcardSize ?? '6x9') === '6x9'
    : (option.pages ?? 1) === 1;
}

/**
 * The Pay & Send product that matches a mail option, sold here or not, or null
 * when none does. An unknown mail type is priced as a letter, the fallback it
 * always had.
 */
export function jitProductMatching(option: MailOption): JitProductDefinition | null {
  const mailType = JIT_PRODUCTS.some(product => product.mailType === option.mailType)
    ? option.mailType
    : JIT_PRODUCTS[0].mailType;
  const service = option.mailService ?? 'standard';
  return JIT_PRODUCTS.find(candidate => {
    if (candidate.mailType !== mailType) return false;
    if (mailType === 'postcard') {
      // A postcard is never certified: a certified postcard has no price, rather than a plain one's.
      return service === 'standard' && candidate.postcardSize === (option.postcardSize ?? '6x9');
    }
    // A certified letter is priced by its service, whatever its pages; every other letter by its pages.
    return service === 'standard'
      ? candidate.mailService === undefined && candidate.pages === (option.pages ?? 1)
      : candidate.mailService === service;
  }) ?? null;
}

/**
 * The Pay & Send product for a mail option, or null when this deployment sells
 * none that matches it. Never a smaller option's product: a two-page letter
 * whose flag is off has no price, rather than the one-page letter's (#578).
 */
export function jitProductFor(
  option: MailOption,
  env: NodeJS.ProcessEnv = process.env
): JitProductDefinition | null {
  const product = jitProductMatching(option);
  return product && isJitProductSold(product, env) ? product : null;
}

export function getConfiguredProducts(env: NodeJS.ProcessEnv = process.env): ConfiguredProduct[] {
  // Hoisted: computing these inside the maps re-read and re-normalized the
  // same env vars up to seven times per call (#278 review round 5).
  const packCcy = packCurrency(env);
  const packs = PACK_PRODUCTS.map(product => configuredRow(product, 'pack', packCcy, env));

  if (env.JIT_PURCHASE_ENABLED !== 'true') return packs;

  const jitCcy = jitCurrency(env);
  const jit = JIT_PRODUCTS
    .filter(product => isJitProductSold(product, env))
    .map(product => configuredRow(product, 'jit', jitCcy, env));
  return [...packs, ...jit];
}

/**
 * ONE product's configured row, without building the full table. The warm
 * read path (every quote validates a memo) paid ~9 env reads and a 5-object
 * table build per call to answer a one-product question (#278 review r6).
 */
export function getConfiguredProduct(
  productCode: string,
  env: NodeJS.ProcessEnv = process.env
): ConfiguredProduct | null {
  const pack = PACK_PRODUCTS.find(product => product.productCode === productCode);
  if (pack) return configuredRow(pack, 'pack', packCurrency(env), env);
  if (env.JIT_PURCHASE_ENABLED !== 'true') return null;
  const jit = JIT_PRODUCTS.find(product => product.productCode === productCode);
  if (!jit || !isJitProductSold(jit, env)) return null;
  return configuredRow(jit, 'jit', jitCurrency(env), env);
}

/**
 * Whether this deployment sells the product, without building the full
 * configured-product table - the answer both quote paths need on every call
 * when Pay & Send is disabled, the shipped default (#278 review round 5).
 */
export function isConfiguredProductCode(
  productCode: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (PACK_PRODUCTS.some(product => product.productCode === productCode)) return true;
  if (env.JIT_PURCHASE_ENABLED !== 'true') return false;
  return JIT_PRODUCTS.some(
    product => product.productCode === productCode && isJitProductSold(product, env)
  );
}

/**
 * Stripe currencies whose minor unit IS the major unit (unit_amount is whole
 * yen/won/dong), and the three-decimal set. Display only: `amount / 100` is
 * wrong by 100x for these, and this codebase declares multi-currency
 * deployments supported (https://docs.stripe.com/currencies#zero-decimal).
 */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'
]);
export const THREE_DECIMAL_CURRENCIES = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** "4.99", "500", or "1.250" - minor units rendered for the given currency. */
export function formatAmountForCurrency(amountMinorUnits: number, currency: string): string {
  const code = normalizedCurrency(currency, 'usd');
  const decimals = ZERO_DECIMAL_CURRENCIES.has(code)
    ? 0
    : THREE_DECIMAL_CURRENCIES.has(code)
      ? 3
      : 2;
  return (amountMinorUnits / 10 ** decimals).toFixed(decimals);
}

import { createHash } from 'node:crypto';
/**
 * The product table: every sellable product, its identity, where its Stripe
 * price id comes from, and THE AMOUNT IT IS EXPECTED TO COST. A leaf module
 * (no src/ imports), so the config layer, the price catalog, the Stripe
 * service, and the reconciliation service can all read the SAME table.
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

import type { MailType } from '../services/types.js';

export type PackProductId = 'credit-pack-4' | 'credit-pack-10' | 'credit-pack-100';
export type ProductGroup = 'pack' | 'jit';

export interface PackProductDefinition {
  readonly productCode: PackProductId;
  readonly credits: number;
  readonly priceEnv: string;
  /**
   * The amount this product is agreed to cost, in minor units of the store
   * currency. The configured Stripe Price MUST resolve to exactly this figure
   * or the catalog refuses to sell the product.
   */
  readonly expectedAmountCents: number;
  readonly name: string;
  readonly description: string;
}

export interface JitProductDefinition {
  readonly productCode: 'jit-letter' | 'jit-postcard';
  readonly mailType: MailType;
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
    priceEnv: 'STRIPE_PRICE_STARTER',
    expectedAmountCents: 500,
    name: 'Starter Pack - 2 Letters',
    description: 'Two prepaid physical letters or postcards'
  },
  {
    productCode: 'credit-pack-10',
    credits: 10,
    priceEnv: 'STRIPE_PRICE_REGULAR',
    expectedAmountCents: 1000,
    name: 'Regular Pack - 5 Letters',
    description: 'Five prepaid physical letters or postcards'
  },
  {
    productCode: 'credit-pack-100',
    credits: 100,
    priceEnv: 'STRIPE_PRICE_POWER',
    expectedAmountCents: 9000,
    name: 'Power Pack - 50 Letters',
    description: 'Fifty prepaid physical letters or postcards'
  }
] as const;

export const JIT_PRODUCTS: readonly JitProductDefinition[] = [
  {
    productCode: 'jit-letter',
    mailType: 'letter',
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
    priceEnv: 'STRIPE_JIT_POSTCARD_PRICE_ID',
    expectedAmountCents: 499,
    name: 'Pay & Send One Physical Postcard',
    description: 'Payment authorizes Letter IRL to print and mail this exact postcard.'
  }
] as const;

/** Env-name lists for the deployment manifest and the cutover preflight. */
export const PACK_PRICE_ENV_VARS: readonly string[] = PACK_PRODUCTS.map(p => p.priceEnv);
export const JIT_PRICE_ENV_VARS: readonly string[] = JIT_PRODUCTS.map(p => p.priceEnv);

/** Credits per pack product - the reconciliation service's map, derived. */
export const PACK_CREDITS_BY_PRODUCT: Readonly<Record<string, number>> = Object.fromEntries(
  PACK_PRODUCTS.map(p => [p.productCode, p.credits])
);

export function isJitPurchaseEnabled(): boolean {
  return process.env.JIT_PURCHASE_ENABLED === 'true';
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

/** The Pay & Send product definition for a mail type, with its fallback. */
export function jitProductDefinition(mailType: MailType): (typeof JIT_PRODUCTS)[number] {
  return JIT_PRODUCTS.find(product => product.mailType === mailType) ?? JIT_PRODUCTS[0];
}

export function getConfiguredProducts(env: NodeJS.ProcessEnv = process.env): ConfiguredProduct[] {
  // Hoisted: computing these inside the maps re-read and re-normalized the
  // same env vars up to seven times per call (#278 review round 5).
  const packCcy = packCurrency(env);
  const packs = PACK_PRODUCTS.map(product => configuredRow(product, 'pack', packCcy, env));

  if (env.JIT_PURCHASE_ENABLED !== 'true') return packs;

  const jitCcy = jitCurrency(env);
  const jit = JIT_PRODUCTS.map(product => configuredRow(product, 'jit', jitCcy, env));
  return [...packs, ...jit];
}

/** The Pay & Send product code for a mail type. */
export function jitProductCode(mailType: MailType): string {
  return jitProductDefinition(mailType).productCode;
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
  if (!jit) return null;
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
  return JIT_PRODUCTS.some(product => product.productCode === productCode);
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

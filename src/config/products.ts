/**
 * The product table: every sellable product, its identity, and where its Stripe
 * price id comes from. A leaf module (no src/ imports), so the config layer,
 * the price catalog, the Stripe service, and the reconciliation service can all
 * read the SAME table.
 *
 * Before this existed the table was copied by hand in three places -
 * PACK_PRODUCTS in stripeService, PACK_PRICE_VARS/JIT_VARS in deploymentConfig,
 * and PRODUCT_CREDITS in stripeReconciliationService (whose comment literally
 * said "must match stripeService.ts") - which is the drift shape behind #160,
 * #270, and #275: lists that must agree, with nothing comparing them.
 */

import type { MailType } from '../services/types.js';

export type PackProductId = 'credit-pack-4' | 'credit-pack-10' | 'credit-pack-100';
export type ProductGroup = 'pack' | 'jit';

export interface PackProductDefinition {
  readonly productCode: PackProductId;
  readonly credits: number;
  readonly priceEnv: string;
  readonly name: string;
  readonly description: string;
}

export interface JitProductDefinition {
  readonly productCode: 'jit-letter' | 'jit-postcard';
  readonly mailType: MailType;
  readonly priceEnv: string;
  readonly name: string;
  readonly description: string;
}

export const PACK_PRODUCTS: readonly PackProductDefinition[] = [
  {
    productCode: 'credit-pack-4',
    credits: 4,
    priceEnv: 'STRIPE_PRICE_STARTER',
    name: 'Starter Pack - 2 Letters',
    description: 'Two prepaid physical letters or postcards'
  },
  {
    productCode: 'credit-pack-10',
    credits: 10,
    priceEnv: 'STRIPE_PRICE_REGULAR',
    name: 'Regular Pack - 5 Letters',
    description: 'Five prepaid physical letters or postcards'
  },
  {
    productCode: 'credit-pack-100',
    credits: 100,
    priceEnv: 'STRIPE_PRICE_POWER',
    name: 'Power Pack - 50 Letters',
    description: 'Fifty prepaid physical letters or postcards'
  }
] as const;

export const JIT_PRODUCTS: readonly JitProductDefinition[] = [
  {
    productCode: 'jit-letter',
    mailType: 'letter',
    priceEnv: 'STRIPE_JIT_LETTER_PRICE_ID',
    name: 'Pay & Send One Physical Letter',
    description: 'Payment authorizes Letter IRL to print and mail this exact letter.'
  },
  {
    productCode: 'jit-postcard',
    mailType: 'postcard',
    priceEnv: 'STRIPE_JIT_POSTCARD_PRICE_ID',
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
  readonly productCode: string;
  readonly group: ProductGroup;
  /** Empty string when the env var is unset - the catalog records that as a failure. */
  readonly priceId: string;
  readonly expectedCurrency: string;
}

/**
 * Every product this deployment sells, with the price id and currency each is
 * expected to resolve to. JIT products appear ONLY when Pay & Send is enabled,
 * mirroring the manifest's `when-jit-enabled` condition - a disabled feature's
 * stale or placeholder price id must not be resolved, and must never be able to
 * fail readiness (#278 review).
 */
export function getConfiguredProducts(env: NodeJS.ProcessEnv = process.env): ConfiguredProduct[] {
  const packs: ConfiguredProduct[] = PACK_PRODUCTS.map(product => ({
    productCode: product.productCode,
    group: 'pack',
    priceId: (env[product.priceEnv] ?? '').trim(),
    expectedCurrency: packCurrency(env)
  }));

  if (env.JIT_PURCHASE_ENABLED !== 'true') return packs;

  const jit: ConfiguredProduct[] = JIT_PRODUCTS.map(product => ({
    productCode: product.productCode,
    group: 'jit',
    priceId: (env[product.priceEnv] ?? '').trim(),
    expectedCurrency: jitCurrency(env)
  }));
  return [...packs, ...jit];
}

/** The Pay & Send product code for a mail type. */
export function jitProductCode(mailType: MailType): string {
  const definition = JIT_PRODUCTS.find(product => product.mailType === mailType);
  return (definition ?? JIT_PRODUCTS[0]).productCode;
}

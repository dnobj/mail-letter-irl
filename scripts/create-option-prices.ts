/**
 * The Pay & Send options' Stripe test-mode Products and Prices, in one command
 * (#624).
 *
 * Room to write (#586), the postcard sizes (#594) and the other mail options
 * each sell through a Pay & Send product whose Stripe Price must exist before
 * its flag can be on: with the flag on and no resolvable Price, /readyz reports
 * `prices` failing and the option's checkout is disabled. Making the Prices by
 * hand in the dashboard is where an amount gets mistyped, and the price
 * catalogue (src/services/priceCatalog.ts) refuses to sell a product whose
 * Price disagrees with the amount pinned in src/config/products.ts. This script
 * creates each Price FROM that table, so the two cannot disagree.
 *
 * Usage, with a TEST key typed in your own shell (never in a chat):
 *   PowerShell:
 *     $env:STRIPE_SECRET_KEY = "sk_test_..."
 *     npx tsx scripts/create-option-prices.ts --out dev-option-prices.txt
 *   bash:
 *     STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/create-option-prices.ts --out dev-option-prices.txt
 *
 *   --out <file>       write the NAME=price_... lines there (default: print them)
 *   --dry-run          read-only: say what would be created
 *   --all              also the base letter and postcard products
 *   --currency <code>  the Prices' currency (default: JIT_CURRENCY, else STRIPE_CURRENCY, else usd)
 *
 * Contract, each line pinned by tests/unit/scripts/createOptionPrices.test.ts:
 * - Test keys only. A live or unrecognised key is refused before any request.
 * - Idempotent. A Price found under the lookup key `letter-irl-<productCode>`
 *   is reused when it is active, one-time, in the right currency and at the
 *   pinned amount, and REFUSED otherwise; nothing is ever edited or archived.
 * - Amount and currency come from JIT_PRODUCTS and jitCurrency, never from here.
 * - The key is never printed, and the output holds price ids only. An --out path
 *   named like an env file is refused, since writing it would overwrite secrets.
 */

import { writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Stripe from 'stripe';
import {
  JIT_PRODUCTS,
  formatAmountForCurrency,
  jitCurrency,
  type JitProductDefinition
} from '../src/config/products.js';
import { getStripeClient } from '../src/services/stripeClient.js';

export type KeyMode = 'test' | 'live' | 'unknown';

/** What a key is, by its prefix: the only thing this script learns about it. */
export function keyMode(key: string | undefined): KeyMode {
  const value = (key ?? '').trim();
  if (value.startsWith('sk_test_') || value.startsWith('rk_test_')) return 'test';
  if (value.startsWith('sk_live_') || value.startsWith('rk_live_')) return 'live';
  return 'unknown';
}

export const LOOKUP_KEY_PREFIX = 'letter-irl-';

/** The lookup key a product's Price is found by, so a second run finds it. */
export function lookupKeyFor(productCode: string): string {
  return `${LOOKUP_KEY_PREFIX}${productCode}`;
}

/** A Price as read back: just the fields the catalogue checks. */
export interface ExistingPrice {
  id: string;
  active: boolean;
  type: string;
  unitAmount: number | null;
  currency: string;
  livemode: boolean;
}

export interface NewPrice {
  lookupKey: string;
  unitAmount: number;
  currency: string;
  productName: string;
  productCode: string;
}

/** The two Stripe operations the script needs: a seam for the tests. */
export interface PricePort {
  findPrice(lookupKey: string): Promise<ExistingPrice | null>;
  createPrice(spec: NewPrice): Promise<{ id: string }>;
}

export type OptionOutcome =
  | { kind: 'create' }
  | { kind: 'reuse'; priceId: string }
  | { kind: 'refuse'; why: string };

/** What to do with one option, given what Stripe holds under its lookup key. */
export function decide(
  definition: Pick<JitProductDefinition, 'expectedAmountCents'>,
  currency: string,
  existing: ExistingPrice | null
): OptionOutcome {
  if (!existing) return { kind: 'create' };
  const refuse = (why: string): OptionOutcome => ({ kind: 'refuse', why });
  if (existing.livemode) return refuse('the Price under its lookup key is a live-mode Price');
  // An archived Price still owns the lookup key, so a new one cannot take it.
  if (!existing.active) return refuse('the Price under its lookup key is archived');
  if (existing.type !== 'one_time') return refuse(`the Price under its lookup key is ${existing.type}, not one-time`);
  if (existing.currency !== currency) {
    return refuse(`the Price under its lookup key is in ${existing.currency}, not ${currency}`);
  }
  if (existing.unitAmount !== definition.expectedAmountCents) {
    return refuse(
      `the Price under its lookup key costs ${existing.unitAmount} minor units, not the pinned ${definition.expectedAmountCents}`
    );
  }
  return { kind: 'reuse', priceId: existing.id };
}

/** The options (products with a flag); with `all`, the base products too. */
export function selectOptions(all: boolean): readonly JitProductDefinition[] {
  return JIT_PRODUCTS.filter(product => all || product.enabledBy);
}

export interface RunOptions {
  port: PricePort;
  currency: string;
  dryRun: boolean;
  all: boolean;
}

export interface RunResult {
  /** `NAME=price_...`, for every product that has a Price now. */
  lines: string[];
  /** One sentence per product, for the person running it. */
  report: string[];
  refused: number;
}

export async function run(options: RunOptions): Promise<RunResult> {
  const lines: string[] = [];
  const report: string[] = [];
  let refused = 0;
  for (const product of selectOptions(options.all)) {
    const lookupKey = lookupKeyFor(product.productCode);
    const outcome = decide(product, options.currency, await options.port.findPrice(lookupKey));
    if (outcome.kind === 'refuse') {
      refused += 1;
      report.push(`REFUSED ${product.productCode}: ${outcome.why}. Nothing was changed.`);
    } else if (outcome.kind === 'reuse') {
      lines.push(`${product.priceEnv}=${outcome.priceId}`);
      report.push(`kept ${product.productCode}: ${outcome.priceId}`);
    } else {
      const amount = `${formatAmountForCurrency(product.expectedAmountCents, options.currency)} ${options.currency.toUpperCase()}`;
      if (options.dryRun) {
        report.push(`would create ${product.productCode} at ${amount}`);
      } else {
        const created = await options.port.createPrice({
          lookupKey,
          unitAmount: product.expectedAmountCents,
          currency: options.currency,
          productName: product.name,
          productCode: product.productCode
        });
        lines.push(`${product.priceEnv}=${created.id}`);
        report.push(`created ${product.productCode} at ${amount}: ${created.id}`);
      }
    }
  }
  return { lines, report, refused };
}

/** The real Stripe client behind the port. */
export function stripePort(stripe: Stripe): PricePort {
  return {
    async findPrice(lookupKey) {
      const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 3 });
      const price = found.data[0];
      if (!price) return null;
      return {
        id: price.id,
        active: price.active,
        type: price.type,
        unitAmount: price.unit_amount,
        currency: price.currency,
        livemode: price.livemode
      };
    },
    async createPrice(spec) {
      // The Product comes with the Price, in one request, so a failure cannot
      // leave a Product with no Price behind. The idempotency key makes a
      // retried request return the first result.
      const price = await stripe.prices.create(
        {
          currency: spec.currency,
          unit_amount: spec.unitAmount,
          lookup_key: spec.lookupKey,
          product_data: {
            name: spec.productName,
            metadata: { productCode: spec.productCode, createdBy: 'scripts/create-option-prices.ts' }
          },
          metadata: { productCode: spec.productCode }
        },
        { idempotencyKey: `letter-irl-option-price:${spec.lookupKey}:${spec.currency}:${spec.unitAmount}` }
      );
      return { id: price.id };
    }
  };
}

export interface CliArgs {
  out: string | undefined;
  dryRun: boolean;
  all: boolean;
  currency: string | undefined;
  help: boolean;
}

export const USAGE = [
  'Usage: STRIPE_SECRET_KEY=<test key> npx tsx scripts/create-option-prices.ts [--out <file>] [--dry-run] [--all] [--currency <code>]',
  "  Creates the Pay & Send options' Stripe test-mode Prices at the amounts pinned in src/config/products.ts."
].join('\n');

export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = { out: undefined, dryRun: false, all: false, currency: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--all') args.all = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--out' || flag === '--currency') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` };
      i += 1;
      if (flag === '--out') args.out = value;
      else args.currency = value.trim().toLowerCase();
    } else return { error: `Unknown argument: ${flag}` };
  }
  // win32.basename reads both separators, whichever system this runs on.
  if (args.out !== undefined && /^\.env/i.test(win32.basename(args.out))) {
    return {
      error: `Refusing to write ${win32.basename(args.out)}: a file named like an env file may hold secrets. Pick another name.`
    };
  }
  if (args.currency !== undefined && !/^[a-z]{3}$/.test(args.currency)) {
    return { error: '--currency takes a three-letter code such as usd' };
  }
  return args;
}

/** Text safe to print: the key, and anything shaped like one, removed. */
export function redact(text: string, key: string | undefined): string {
  let out = text;
  const secret = (key ?? '').trim();
  if (secret) out = out.split(secret).join('[key]');
  return out.replace(/\b[sr]k_(?:test|live)_[A-Za-z0-9*]+/g, '[key]');
}

export interface Deps {
  /** Built only after the key checks pass, so a refused key never reaches Stripe. */
  createPort(): PricePort;
  writeFile(path: string, text: string): void;
  log(line: string): void;
  error(line: string): void;
}

/** The whole command, returning the exit code: 0 done, 1 failed or refused a Price, 2 not run. */
export async function execute(argv: readonly string[], env: NodeJS.ProcessEnv, deps: Deps): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    deps.error(parsed.error);
    deps.error(USAGE);
    return 2;
  }
  if (parsed.help) {
    deps.log(USAGE);
    return 0;
  }
  const mode = keyMode(env.STRIPE_SECRET_KEY);
  if (mode !== 'test') {
    deps.error(
      mode === 'live'
        ? 'STRIPE_SECRET_KEY is a live-mode key. This script only uses a test-mode key (sk_test_ or rk_test_); production prices are made by the owner once the price proposal is approved.'
        : 'STRIPE_SECRET_KEY must be set to a Stripe test-mode key (sk_test_ or rk_test_).'
    );
    return 2;
  }
  const currency = parsed.currency ?? jitCurrency(env);
  try {
    const result = await run({ port: deps.createPort(), currency, dryRun: parsed.dryRun, all: parsed.all });
    for (const line of result.report) deps.log(line);
    if (parsed.dryRun) {
      deps.log('Dry run: nothing was created or written.');
    } else if (result.lines.length > 0) {
      const text = [
        '# Letter IRL option prices (Stripe test mode): price ids only, no secrets',
        ...result.lines,
        ''
      ].join('\n');
      if (parsed.out) {
        deps.writeFile(parsed.out, text);
        deps.log(`Wrote ${result.lines.length} line(s) to ${parsed.out}`);
      } else {
        deps.log('');
        for (const line of result.lines) deps.log(line);
      }
    }
    return result.refused > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.error(`Stopped: ${redact(message, env.STRIPE_SECRET_KEY)}`);
    deps.error('Running it again is safe: the prices already made are found and kept.');
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await execute(process.argv.slice(2), process.env, {
    createPort: () => stripePort(getStripeClient()),
    writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
    log: line => console.log(line),
    error: line => console.error(line)
  });
}

// Entry guard mirrors scripts/preflight-cutover.ts: importing this module (the
// unit tests do) never fires a request.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(redact(error instanceof Error ? error.message : String(error), process.env.STRIPE_SECRET_KEY));
    process.exitCode = 1;
  });
}

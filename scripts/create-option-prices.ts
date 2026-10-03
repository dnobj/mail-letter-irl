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
 *   --currency <code>  the Prices' currency (default: JIT_CURRENCY, else STRIPE_CURRENCY, else usd,
 *                      read from your shell: match the development services)
 *
 * Contract, each line pinned by tests/unit/scripts/createOptionPrices.test.ts:
 * - Test keys only. A live or unrecognised key is refused before any request.
 * - Idempotent. A Price found under the lookup key `letter-irl-<productCode>`
 *   is reused when it is active, one-time, in the right currency and at the
 *   pinned amount, and REFUSED otherwise; nothing is ever edited or archived.
 * - The amount comes from JIT_PRODUCTS and the currency from --currency or jitCurrency,
 *   never from a literal here.
 * - The key is never printed: everything the script prints passes through redact,
 *   and the output file holds price ids only. --out replaces only a file an
 *   earlier run of this script wrote (it starts with OUTPUT_HEADER), checked before
 *   any request, dry runs included; a name like an env file is refused outright.
 * - A failure partway shows each Price decided so far, and a second run is safe.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * What a key is, by its prefix: the only thing this script learns about it. The
 * string is read exactly as given, never trimmed, so the key checked is the key
 * getStripeClient uses; a key with any whitespace in it is unknown, and refused.
 */
export function keyMode(key: string | undefined): KeyMode {
  const value = key ?? '';
  if (/\s/.test(value)) return 'unknown';
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
  /** Called with each report line as it is decided, so a failure partway still shows what happened. */
  onReport?: (line: string) => void;
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
  const say = (line: string): void => {
    report.push(line);
    options.onReport?.(line);
  };
  let refused = 0;
  for (const product of selectOptions(options.all)) {
    const lookupKey = lookupKeyFor(product.productCode);
    const outcome = decide(product, options.currency, await options.port.findPrice(lookupKey));
    if (outcome.kind === 'refuse') {
      refused += 1;
      say(`REFUSED ${product.productCode}: ${outcome.why}. Nothing was changed.`);
    } else if (outcome.kind === 'reuse') {
      lines.push(`${product.priceEnv}=${outcome.priceId}`);
      say(`kept ${product.productCode}: ${outcome.priceId}`);
    } else {
      const amount = `${formatAmountForCurrency(product.expectedAmountCents, options.currency)} ${options.currency.toUpperCase()}`;
      if (options.dryRun) {
        say(`would create ${product.productCode} at ${amount}`);
      } else {
        const created = await options.port.createPrice({
          lookupKey,
          unitAmount: product.expectedAmountCents,
          currency: options.currency,
          productName: product.name,
          productCode: product.productCode
        });
        lines.push(`${product.priceEnv}=${created.id}`);
        say(`created ${product.productCode} at ${amount}: ${created.id}`);
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
      // leave a Product with no Price behind. stripe-node sends one idempotency
      // key per request and reuses it across its retry, so a retried request
      // never makes a second Price; a later run finds the first by its lookup
      // key. No key of our own: one that outlived the run could replay an old
      // answer after a lookup key was freed.
      const price = await stripe.prices.create({
        currency: spec.currency,
        unit_amount: spec.unitAmount,
        lookup_key: spec.lookupKey,
        product_data: {
          name: spec.productName,
          metadata: { productCode: spec.productCode, createdBy: 'scripts/create-option-prices.ts' }
        },
        metadata: { productCode: spec.productCode }
      });
      // A test key makes test-mode objects only; this is the last line of defence.
      if (price.livemode) throw new Error(`Stripe made a live-mode Price (${price.id}); stopping`);
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
  'Usage: npx tsx scripts/create-option-prices.ts [--out <file>] [--dry-run] [--all] [--currency <code>]',
  '  STRIPE_SECRET_KEY must be set in your shell to a Stripe TEST key (sk_test_ or rk_test_), with no spaces around it.',
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
  // win32 reads both separators, whichever system this runs on. The path is
  // resolved first, so a trailing "." or ".." segment cannot hide the name.
  const outName = args.out === undefined ? '' : win32.basename(win32.resolve(args.out));
  if (/^\.env/i.test(outName)) {
    return { error: `Refusing to write ${outName}: a file named like an env file may hold secrets. Pick another name.` };
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

/** The first line of what this script writes: --out replaces only a file that starts with it. */
export const OUTPUT_HEADER = '# Letter IRL option prices (Stripe test mode): price ids only, no secrets';

/** Whether --out may replace a file: it is not there, or an earlier run of this script wrote it. */
export function mayReplace(existing: string | null): boolean {
  if (existing === null) return true;
  // An editor may have saved the file with a byte order mark in front.
  const text = existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing;
  return text.startsWith(OUTPUT_HEADER);
}

export interface Deps {
  /** Built only after the key checks pass, so a refused key never reaches Stripe. */
  createPort(): PricePort;
  /** What the file holds, or null when there is no such file. */
  readFile(path: string): string | null;
  writeFile(path: string, text: string): void;
  log(line: string): void;
  error(line: string): void;
}

/** The whole command, returning the exit code: 0 done, 1 failed or refused a Price, 2 not run. */
export async function execute(argv: readonly string[], env: NodeJS.ProcessEnv, deps: Deps): Promise<number> {
  // Everything printed passes through redact: a key typed where an argument
  // belongs, or one inside an error, never reaches the screen or a log.
  const say = (line: string): void => deps.log(redact(line, env.STRIPE_SECRET_KEY));
  const warn = (line: string): void => deps.error(redact(line, env.STRIPE_SECRET_KEY));
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    warn(parsed.error);
    warn(USAGE);
    return 2;
  }
  if (parsed.help) {
    say(USAGE);
    return 0;
  }
  const mode = keyMode(env.STRIPE_SECRET_KEY);
  if (mode !== 'test') {
    warn(
      mode === 'live'
        ? 'STRIPE_SECRET_KEY is a live-mode key. This script only uses a test-mode key (sk_test_ or rk_test_); production prices are made by the owner once the price proposal is approved.'
        : 'STRIPE_SECRET_KEY must be set to a Stripe test-mode key (sk_test_ or rk_test_), with no spaces around it.'
    );
    return 2;
  }
  if (parsed.out) {
    // Before any request, so a refused path costs nothing. A dry run looks too,
    // so "look first" shows a path the real run would refuse.
    try {
      if (!mayReplace(deps.readFile(parsed.out))) {
        warn(`${parsed.out} exists and was not written by this script, so it is left alone. Pick another name.`);
        return 2;
      }
    } catch (error) {
      warn(`Cannot use ${parsed.out}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }
  const currency = parsed.currency ?? jitCurrency(env);
  try {
    const result = await run({
      port: deps.createPort(),
      currency,
      dryRun: parsed.dryRun,
      all: parsed.all,
      onReport: say
    });
    if (parsed.dryRun) {
      say('Dry run: nothing was created or written.');
    } else if (result.lines.length > 0) {
      const text = [OUTPUT_HEADER, ...result.lines, ''].join('\n');
      if (parsed.out) {
        try {
          deps.writeFile(parsed.out, text);
        } catch (error) {
          // The Prices exist now, so show the lines: nothing is lost.
          warn(`Could not write ${parsed.out}: ${error instanceof Error ? error.message : String(error)}`);
          say('');
          for (const line of result.lines) say(line);
          return 1;
        }
        say(`Wrote ${result.lines.length} line(s) to ${parsed.out}`);
      } else {
        say('');
        for (const line of result.lines) say(line);
      }
    } else if (parsed.out) {
      say(`${parsed.out} was left as it was: there are no prices to write.`);
    }
    return result.refused > 0 ? 1 : 0;
  } catch (error) {
    warn(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
    warn('Running it again is safe: the prices already made are found and kept.');
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await execute(process.argv.slice(2), process.env, {
    createPort: () => stripePort(getStripeClient()),
    readFile: path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
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

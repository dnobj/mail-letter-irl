import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  JIT_OPTION_PRICE_ENV_VARS,
  JIT_PRODUCTS,
  formatAmountForCurrency
} from '../../../src/config/products.js';
import {
  LOOKUP_KEY_PREFIX,
  decide,
  execute,
  keyMode,
  lookupKeyFor,
  parseArgs,
  redact,
  run,
  selectOptions,
  stripePort,
  type Deps,
  type ExistingPrice,
  type NewPrice,
  type PricePort
} from '../../../scripts/create-option-prices.js';

/**
 * #624. The script makes the Pay & Send options' Stripe test-mode Prices from
 * the table the price catalogue trusts. What these tests protect: a Price is
 * only ever made at the pinned amount, a second run changes nothing, a live
 * key never reaches Stripe, and the key never reaches the output.
 */

const OPTIONS = JIT_PRODUCTS.filter(product => product.enabledBy);
const TEST_KEY = 'sk_test_51AbCdEfGhIjKlMnOpQrSt';
const BACKSLASH = String.fromCharCode(92);

function priceFor(spec: Pick<NewPrice, 'unitAmount' | 'currency'>, id = 'price_old', over: Partial<ExistingPrice> = {}): ExistingPrice {
  return { id, active: true, type: 'one_time', unitAmount: spec.unitAmount, currency: spec.currency, livemode: false, ...over };
}

/** A Stripe account that remembers its Prices by lookup key. */
function fakeAccount(initial: Record<string, ExistingPrice> = {}) {
  const prices = new Map(Object.entries(initial));
  const created: NewPrice[] = [];
  const port: PricePort = {
    findPrice: vi.fn(async (lookupKey: string) => prices.get(lookupKey) ?? null),
    createPrice: vi.fn(async (spec: NewPrice) => {
      const id = `price_test_${created.length + 1}`;
      created.push(spec);
      prices.set(spec.lookupKey, priceFor(spec, id));
      return { id };
    })
  };
  return { port, created, prices };
}

describe('keyMode', () => {
  it('reads a test key by its prefix, secret or restricted', () => {
    expect(keyMode('sk_test_abc')).toBe('test');
    expect(keyMode('rk_test_abc')).toBe('test');
    expect(keyMode('  sk_test_abc  ')).toBe('test');
  });

  it('reads a live key by its prefix, secret or restricted', () => {
    expect(keyMode('sk_live_abc')).toBe('live');
    expect(keyMode('rk_live_abc')).toBe('live');
  });

  it('knows nothing else', () => {
    for (const other of [undefined, '', '   ', 'pk_test_abc', 'sk_prod_abc', 'whsec_abc', 'test_sk_abc']) {
      expect(keyMode(other)).toBe('unknown');
    }
  });
});

describe('lookupKeyFor', () => {
  it('names the Price after the product, under one prefix', () => {
    expect(LOOKUP_KEY_PREFIX).toBe('letter-irl-');
    expect(lookupKeyFor('jit-letter-2-pages')).toBe('letter-irl-jit-letter-2-pages');
  });
});

describe('selectOptions', () => {
  it('is the products a flag sells, and they are the ones the manifest wants a price for', () => {
    expect(OPTIONS.length).toBeGreaterThanOrEqual(4);
    expect(selectOptions(false).map(product => product.productCode)).toEqual(OPTIONS.map(product => product.productCode));
    expect(selectOptions(false).map(product => product.priceEnv)).toEqual(
      JIT_OPTION_PRICE_ENV_VARS.map(option => option.priceEnv)
    );
  });

  it('is every Pay & Send product with all, the base letter and postcard too', () => {
    const all = selectOptions(true).map(product => product.productCode);
    expect(all).toEqual(JIT_PRODUCTS.map(product => product.productCode));
    expect(all).toContain('jit-letter');
    expect(all).toContain('jit-postcard');
  });
});

describe('decide', () => {
  const pinned = { expectedAmountCents: 599 };
  const right = priceFor({ unitAmount: 599, currency: 'usd' });

  it('creates when nothing holds the lookup key', () => {
    expect(decide(pinned, 'usd', null)).toEqual({ kind: 'create' });
  });

  it('keeps a Price that is active, one-time, in the currency and at the pinned amount', () => {
    expect(decide(pinned, 'usd', right)).toEqual({ kind: 'reuse', priceId: 'price_old' });
  });

  it.each([
    ['a live-mode Price', { livemode: true }, /live-mode/],
    ['an archived Price', { active: false }, /archived/],
    ['a recurring Price', { type: 'recurring' }, /recurring, not one-time/],
    ['another currency', { currency: 'eur' }, /in eur, not usd/],
    ['another amount', { unitAmount: 600 }, /costs 600 minor units, not the pinned 599/],
    ['no amount (tiered or metered)', { unitAmount: null }, /costs null minor units/]
  ] as const)('refuses %s', (_name, over, why) => {
    const outcome = decide(pinned, 'usd', { ...right, ...over });
    expect(outcome.kind).toBe('refuse');
    expect((outcome as { why: string }).why).toMatch(why);
  });

  it('checks the live-mode flag before anything else', () => {
    const outcome = decide(pinned, 'usd', { ...right, livemode: true, active: false, unitAmount: 1 });
    expect((outcome as { why: string }).why).toMatch(/live-mode/);
  });
});

describe('run', () => {
  it('creates every option at the amount the table pins, in the currency given', async () => {
    const account = fakeAccount();
    const result = await run({ port: account.port, currency: 'usd', dryRun: false, all: false });

    expect(account.created.map(spec => spec.productCode)).toEqual(OPTIONS.map(product => product.productCode));
    for (const spec of account.created) {
      const product = OPTIONS.find(candidate => candidate.productCode === spec.productCode)!;
      expect(spec).toEqual({
        lookupKey: `letter-irl-${product.productCode}`,
        unitAmount: product.expectedAmountCents,
        currency: 'usd',
        productName: product.name,
        productCode: product.productCode
      });
    }
    expect(result.lines).toEqual(OPTIONS.map((product, i) => `${product.priceEnv}=price_test_${i + 1}`));
    expect(result.refused).toBe(0);
  });

  it('takes the currency it is given, and prints each amount in it', async () => {
    const account = fakeAccount();
    const result = await run({ port: account.port, currency: 'eur', dryRun: false, all: false });
    expect(account.created.every(spec => spec.currency === 'eur')).toBe(true);
    const first = OPTIONS[0];
    expect(result.report[0]).toContain(`${formatAmountForCurrency(first.expectedAmountCents, 'eur')} EUR`);
  });

  it('changes nothing the second time, and returns the same lines', async () => {
    const account = fakeAccount();
    const first = await run({ port: account.port, currency: 'usd', dryRun: false, all: false });
    const madeAfterFirst = (account.port.createPrice as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = await run({ port: account.port, currency: 'usd', dryRun: false, all: false });

    expect((account.port.createPrice as ReturnType<typeof vi.fn>).mock.calls.length).toBe(madeAfterFirst);
    expect(second.lines).toEqual(first.lines);
    expect(second.report.every(line => line.startsWith('kept '))).toBe(true);
  });

  it('refuses a Price at another amount, changes nothing for it, and still makes the rest', async () => {
    const [wrong, ...others] = OPTIONS;
    const account = fakeAccount({
      [lookupKeyFor(wrong.productCode)]: priceFor({ unitAmount: wrong.expectedAmountCents + 1, currency: 'usd' }, 'price_wrong')
    });
    const result = await run({ port: account.port, currency: 'usd', dryRun: false, all: false });

    expect(result.refused).toBe(1);
    expect(account.created.map(spec => spec.productCode)).toEqual(others.map(product => product.productCode));
    expect(result.lines.some(line => line.startsWith(`${wrong.priceEnv}=`))).toBe(false);
    expect(result.report[0].startsWith(`REFUSED ${wrong.productCode}: `)).toBe(true);
    expect(result.report[0].endsWith('Nothing was changed.')).toBe(true);
    expect(account.prices.get(lookupKeyFor(wrong.productCode))?.id).toBe('price_wrong');
  });

  it('creates nothing in a dry run, and says what it would create', async () => {
    const account = fakeAccount();
    const result = await run({ port: account.port, currency: 'usd', dryRun: true, all: false });
    expect(account.port.createPrice).not.toHaveBeenCalled();
    expect(result.lines).toEqual([]);
    expect(result.report).toHaveLength(OPTIONS.length);
    expect(result.report.every(line => line.startsWith('would create '))).toBe(true);
  });

  it('keeps the Prices that exist in a dry run too', async () => {
    const [first] = OPTIONS;
    const account = fakeAccount({
      [lookupKeyFor(first.productCode)]: priceFor({ unitAmount: first.expectedAmountCents, currency: 'usd' }, 'price_here')
    });
    const result = await run({ port: account.port, currency: 'usd', dryRun: true, all: false });
    expect(result.lines).toEqual([`${first.priceEnv}=price_here`]);
  });

  it('makes the base letter and postcard Prices too with all', async () => {
    const account = fakeAccount();
    const result = await run({ port: account.port, currency: 'usd', dryRun: false, all: true });
    expect(account.created).toHaveLength(JIT_PRODUCTS.length);
    expect(result.lines.some(line => line.startsWith('STRIPE_JIT_LETTER_PRICE_ID='))).toBe(true);
    expect(result.lines.some(line => line.startsWith('STRIPE_JIT_POSTCARD_PRICE_ID='))).toBe(true);
  });
});

describe('stripePort', () => {
  function fakeStripe(found: unknown[] = []) {
    const stripe = {
      prices: {
        list: vi.fn(async () => ({ data: found })),
        create: vi.fn(async () => ({ id: 'price_new' }))
      }
    };
    return { stripe, port: stripePort(stripe as unknown as Stripe) };
  }

  it('looks a Price up by its lookup key and reads back what the catalogue checks', async () => {
    // Every field holds a value other than its usual one, so a field read from
    // the wrong place, or not read, shows.
    const { stripe, port } = fakeStripe([
      { id: 'price_1', active: false, type: 'recurring', unit_amount: 599, currency: 'eur', livemode: true, extra: 'ignored' }
    ]);
    await expect(port.findPrice('letter-irl-jit-letter-2-pages')).resolves.toEqual({
      id: 'price_1',
      active: false,
      type: 'recurring',
      unitAmount: 599,
      currency: 'eur',
      livemode: true
    });
    expect(stripe.prices.list).toHaveBeenCalledWith({ lookup_keys: ['letter-irl-jit-letter-2-pages'], limit: 3 });
  });

  it('finds nothing when no Price holds the lookup key', async () => {
    const { port } = fakeStripe([]);
    await expect(port.findPrice('letter-irl-x')).resolves.toBeNull();
  });

  it('creates the Product with the Price, at the amount, in the currency, under the lookup key', async () => {
    const { stripe, port } = fakeStripe();
    const spec: NewPrice = {
      lookupKey: 'letter-irl-jit-letter-2-pages',
      unitAmount: 599,
      currency: 'usd',
      productName: 'Pay & Send One Two-Page Letter',
      productCode: 'jit-letter-2-pages'
    };
    await expect(port.createPrice(spec)).resolves.toEqual({ id: 'price_new' });
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
    const [body, options] = stripe.prices.create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(body).toEqual({
      currency: 'usd',
      unit_amount: 599,
      lookup_key: 'letter-irl-jit-letter-2-pages',
      product_data: {
        name: 'Pay & Send One Two-Page Letter',
        metadata: { productCode: 'jit-letter-2-pages', createdBy: 'scripts/create-option-prices.ts' }
      },
      metadata: { productCode: 'jit-letter-2-pages' }
    });
    expect(options).toEqual({ idempotencyKey: 'letter-irl-option-price:letter-irl-jit-letter-2-pages:usd:599' });
  });

  it('keys a retry by the amount and currency, so a changed pin is never answered with an old Price', async () => {
    const { stripe, port } = fakeStripe();
    const base: NewPrice = { lookupKey: 'letter-irl-x', unitAmount: 599, currency: 'usd', productName: 'X', productCode: 'x' };
    await port.createPrice(base);
    await port.createPrice({ ...base, unitAmount: 699 });
    await port.createPrice({ ...base, currency: 'eur' });
    const keys = stripe.prices.create.mock.calls.map(call => (call as unknown as [unknown, { idempotencyKey: string }])[1].idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('redact', () => {
  it('removes the key it was given, wherever it appears', () => {
    expect(redact(`bad key ${TEST_KEY} and again ${TEST_KEY}`, TEST_KEY)).toBe('bad key [key] and again [key]');
  });

  it('removes anything shaped like a key, as Stripe masks one in an error', () => {
    expect(redact('Invalid API Key provided: sk_test_****abcd', undefined)).toBe('Invalid API Key provided: [key]');
    expect(redact('rk_live_abc123 and sk_live_xyz', undefined)).toBe('[key] and [key]');
  });

  it('removes a key the pattern would only half match, with or without stray spaces around it', () => {
    const odd = 'sk_test_ab-cd_ef';
    expect(redact(`bad ${odd} here`, odd)).toBe('bad [key] here');
    expect(redact(`bad ${odd} here`, `  ${odd} `)).toBe('bad [key] here');
  });

  it('leaves other text alone', () => {
    expect(redact('No such price: price_123', TEST_KEY)).toBe('No such price: price_123');
    expect(redact('nothing to hide', '')).toBe('nothing to hide');
  });
});

describe('parseArgs', () => {
  const DOT_ENV = String.fromCharCode(46) + 'env';

  it('defaults to a real run of the options, printing', () => {
    expect(parseArgs([])).toEqual({ out: undefined, dryRun: false, all: false, currency: undefined, help: false });
  });

  it('reads every flag', () => {
    expect(parseArgs(['--out', 'prices.txt', '--dry-run', '--all', '--currency', ' EUR '])).toEqual({
      out: 'prices.txt',
      dryRun: true,
      all: true,
      currency: 'eur',
      help: false
    });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
    expect(parseArgs(['-h'])).toMatchObject({ help: true });
  });

  it('refuses an unknown argument and a flag with no value', () => {
    expect(parseArgs(['--force'])).toEqual({ error: 'Unknown argument: --force' });
    expect(parseArgs(['--out'])).toEqual({ error: '--out needs a value' });
    expect(parseArgs(['--out', '--dry-run'])).toEqual({ error: '--out needs a value' });
    expect(parseArgs(['--currency'])).toEqual({ error: '--currency needs a value' });
  });

  it('refuses a currency that is not a three-letter code', () => {
    expect(parseArgs(['--currency', 'dollars'])).toHaveProperty('error');
    expect(parseArgs(['--currency', 'us'])).toHaveProperty('error');
    expect(parseArgs(['--currency', 'usd'])).toMatchObject({ currency: 'usd' });
  });

  it('refuses to write a file named like an env file, whichever separator the path uses', () => {
    const windowsPath = ['C:', 'letter-irl-scripts', `${DOT_ENV}.dev`].join(BACKSLASH);
    for (const out of [DOT_ENV, `${DOT_ENV}.dev`, `${DOT_ENV.toUpperCase()}.local`, `/tmp/${DOT_ENV}`, windowsPath]) {
      expect(parseArgs(['--out', out]), out).toHaveProperty('error');
    }
  });

  it('writes anywhere else, even a name that merely contains env', () => {
    const windowsPath = ['C:', 'letter-irl-scripts', 'dev-option-prices.txt'].join(BACKSLASH);
    for (const out of ['dev-option-prices.txt', 'environment.txt', `my${DOT_ENV}.txt`, '/tmp/prices', windowsPath]) {
      expect(parseArgs(['--out', out]), out).toMatchObject({ out });
    }
  });
});

describe('execute', () => {
  const DOT_ENV = String.fromCharCode(46) + 'env';
  const env = { STRIPE_SECRET_KEY: TEST_KEY } as NodeJS.ProcessEnv;

  function harness(account = fakeAccount()) {
    const logs: string[] = [];
    const errors: string[] = [];
    const files: Array<{ path: string; text: string }> = [];
    const createPort = vi.fn(() => account.port);
    const deps: Deps = {
      createPort,
      writeFile: (path, text) => {
        files.push({ path, text });
      },
      log: line => {
        logs.push(line);
      },
      error: line => {
        errors.push(line);
      }
    };
    const everything = () => [...logs, ...errors, ...files.map(file => file.text)].join('\n');
    return { deps, logs, errors, files, createPort, account, everything };
  }

  it('refuses a live key before anything is built, and never prints it', async () => {
    const h = harness();
    const code = await execute([], { STRIPE_SECRET_KEY: 'sk_live_51AbCdEfGh' }, h.deps);
    expect(code).toBe(2);
    expect(h.createPort).not.toHaveBeenCalled();
    expect(h.files).toEqual([]);
    expect(h.errors.join(' ')).toMatch(/live-mode key/);
    expect(h.everything()).not.toContain('sk_live_51AbCdEfGh');
  });

  it('refuses a missing or unrecognised key before anything is built', async () => {
    for (const key of [undefined, '', 'pk_test_abc', 'whsec_abc']) {
      const h = harness();
      expect(await execute([], { STRIPE_SECRET_KEY: key }, h.deps), String(key)).toBe(2);
      expect(h.createPort).not.toHaveBeenCalled();
      expect(h.errors.join(' ')).toMatch(/test-mode key/);
    }
  });

  it('accepts a restricted test key', async () => {
    const h = harness();
    expect(await execute([], { STRIPE_SECRET_KEY: 'rk_test_51AbCdEf' }, h.deps)).toBe(0);
    expect(h.createPort).toHaveBeenCalledTimes(1);
  });

  it('creates the options and writes their lines to the file, with no secret in it', async () => {
    const h = harness();
    const code = await execute(['--out', 'dev-option-prices.txt'], env, h.deps);

    expect(code).toBe(0);
    expect(h.files).toHaveLength(1);
    expect(h.files[0].path).toBe('dev-option-prices.txt');
    const lines = h.files[0].text.split('\n').filter(line => line && !line.startsWith('#'));
    expect(lines).toHaveLength(OPTIONS.length);
    for (const line of lines) expect(line).toMatch(/^STRIPE_JIT_[A-Z0-9_]+_PRICE_ID=price_test_[0-9]+$/);
    expect(h.files[0].text.startsWith('# Letter IRL option prices (Stripe test mode)')).toBe(true);
    expect(h.logs).toContain(`Wrote ${OPTIONS.length} line(s) to dev-option-prices.txt`);
    expect(h.everything()).not.toContain(TEST_KEY);
  });

  it('prints the lines when there is no --out, and writes no file', async () => {
    const h = harness();
    expect(await execute([], env, h.deps)).toBe(0);
    expect(h.files).toEqual([]);
    for (const [i, product] of OPTIONS.entries()) expect(h.logs).toContain(`${product.priceEnv}=price_test_${i + 1}`);
  });

  it('reads only in a dry run: nothing created, no file even with --out', async () => {
    const h = harness();
    expect(await execute(['--dry-run', '--out', 'dev-option-prices.txt'], env, h.deps)).toBe(0);
    expect(h.account.port.createPrice).not.toHaveBeenCalled();
    expect(h.files).toEqual([]);
    expect(h.logs).toContain('Dry run: nothing was created or written.');
  });

  it('exits 1 when a Price is refused, and still writes the others', async () => {
    const [wrong] = OPTIONS;
    const account = fakeAccount({
      [lookupKeyFor(wrong.productCode)]: priceFor({ unitAmount: wrong.expectedAmountCents + 1, currency: 'usd' })
    });
    const h = harness(account);
    expect(await execute(['--out', 'prices.txt'], env, h.deps)).toBe(1);
    expect(h.files[0].text.split('\n').filter(line => line && !line.startsWith('#'))).toHaveLength(OPTIONS.length - 1);
    expect(h.logs.some(line => line.startsWith(`REFUSED ${wrong.productCode}`))).toBe(true);
  });

  it('writes nothing when every Price is refused', async () => {
    const seeded = Object.fromEntries(
      OPTIONS.map(product => [lookupKeyFor(product.productCode), priceFor({ unitAmount: 1, currency: 'usd' })])
    );
    const h = harness(fakeAccount(seeded));
    expect(await execute(['--out', 'prices.txt'], env, h.deps)).toBe(1);
    expect(h.files).toEqual([]);
  });

  it('reports a Stripe failure with the key removed, and says to run it again', async () => {
    const h = harness();
    (h.account.port.findPrice as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(`Invalid API Key provided: ${TEST_KEY}`)
    );
    expect(await execute([], env, h.deps)).toBe(1);
    expect(h.errors[0]).toBe('Stopped: Invalid API Key provided: [key]');
    expect(h.errors.join(' ')).toMatch(/Running it again is safe/);
    expect(h.everything()).not.toContain(TEST_KEY);
  });

  it('reports a failed write the same way, not as a crash', async () => {
    const h = harness();
    h.deps.writeFile = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(await execute(['--out', 'prices.txt'], env, h.deps)).toBe(1);
    expect(h.errors[0]).toBe('Stopped: EACCES: permission denied');
  });

  it('exits 2 on a usage error before it looks at the key', async () => {
    const h = harness();
    expect(await execute(['--nope'], {}, h.deps)).toBe(2);
    expect(h.createPort).not.toHaveBeenCalled();
    expect(h.errors[0]).toBe('Unknown argument: --nope');
  });

  it('prints its usage for --help and needs no key', async () => {
    const h = harness();
    expect(await execute(['--help'], {}, h.deps)).toBe(0);
    expect(h.logs[0]).toContain('Usage:');
    expect(h.createPort).not.toHaveBeenCalled();
  });

  it('refuses an env-named --out before any request', async () => {
    const h = harness();
    expect(await execute(['--out', `${DOT_ENV}.dev`], env, h.deps)).toBe(2);
    expect(h.createPort).not.toHaveBeenCalled();
    expect(h.files).toEqual([]);
  });

  it('takes the currency from --currency, then JIT_CURRENCY, then STRIPE_CURRENCY, then usd', async () => {
    const currencyOf = async (args: string[], extra: Record<string, string>) => {
      const h = harness();
      await execute(args, { ...env, ...extra } as NodeJS.ProcessEnv, h.deps);
      return h.account.created[0].currency;
    };
    expect(await currencyOf([], {})).toBe('usd');
    expect(await currencyOf([], { STRIPE_CURRENCY: 'CAD' })).toBe('cad');
    expect(await currencyOf([], { STRIPE_CURRENCY: 'cad', JIT_CURRENCY: 'EUR' })).toBe('eur');
    expect(await currencyOf(['--currency', 'GBP'], { JIT_CURRENCY: 'eur' })).toBe('gbp');
  });
});

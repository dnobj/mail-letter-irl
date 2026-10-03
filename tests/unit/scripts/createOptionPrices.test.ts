import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  JIT_OPTION_PRICE_ENV_VARS,
  JIT_PRODUCTS,
  formatAmountForCurrency
} from '../../../src/config/products.js';
import {
  LOOKUP_KEY_PREFIX,
  LiveModePriceError,
  OUTPUT_HEADER,
  USAGE,
  decide,
  execute,
  keyMode,
  lookupKeyFor,
  mayReplace,
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
  });

  it('reads a live key by its prefix, secret or restricted', () => {
    expect(keyMode('sk_live_abc')).toBe('live');
    expect(keyMode('rk_live_abc')).toBe('live');
  });

  it('knows nothing else', () => {
    // A stray space is not trimmed away: the key checked must be the key used.
    for (const other of [undefined, '', '   ', 'pk_test_abc', 'sk_prod_abc', 'whsec_abc', 'test_sk_abc', ' sk_test_abc', 'sk_test_abc ']) {
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
    expect(second.report).toHaveLength(OPTIONS.length);
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

  it('reports each line as it is decided, so a failure partway still shows what was made', async () => {
    const account = fakeAccount();
    const heard: string[] = [];
    const result = await run({ port: account.port, currency: 'usd', dryRun: false, all: false, onReport: line => heard.push(line) });
    expect(heard).toEqual(result.report);

    const failing = fakeAccount();
    (failing.port.createPrice as ReturnType<typeof vi.fn>).mockImplementationOnce(async (spec: NewPrice) => {
      failing.created.push(spec);
      return { id: 'price_first' };
    }).mockRejectedValueOnce(new Error('network down'));
    const seen: string[] = [];
    await expect(
      run({ port: failing.port, currency: 'usd', dryRun: false, all: false, onReport: line => seen.push(line) })
    ).rejects.toThrow('network down');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('price_first');
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
      currency: 'eur',
      productName: 'Pay & Send One Two-Page Letter',
      productCode: 'jit-letter-2-pages'
    };
    await expect(port.createPrice(spec)).resolves.toEqual({ id: 'price_new' });
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
    // One argument: no idempotency key of our own, which could outlive the run and replay an old answer.
    expect(stripe.prices.create.mock.calls[0]).toHaveLength(1);
    const [body] = stripe.prices.create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body).toEqual({
      currency: 'eur',
      unit_amount: 599,
      lookup_key: 'letter-irl-jit-letter-2-pages',
      product_data: {
        name: 'Pay & Send One Two-Page Letter',
        metadata: { productCode: 'jit-letter-2-pages', createdBy: 'scripts/create-option-prices.ts' }
      },
      metadata: { productCode: 'jit-letter-2-pages' }
    });
  });

  it('stops if Stripe says the Price it made is live-mode, whatever the key was', async () => {
    const { stripe, port } = fakeStripe();
    stripe.prices.create.mockResolvedValueOnce({ id: 'price_live', livemode: true } as never);
    const spec: NewPrice = { lookupKey: 'letter-irl-x', unitAmount: 599, currency: 'usd', productName: 'X', productCode: 'x' };
    const refused = port.createPrice(spec);
    await expect(refused).rejects.toBeInstanceOf(LiveModePriceError);
    await expect(refused).rejects.toThrow('Stripe made a live-mode Price (price_live); stopping');
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

  it('replaces a key by name only when it is long enough to be one, and the shape pattern masks the rest', () => {
    expect(redact('x abcdefghijkl y', 'abcdefghijkl')).toBe('x [key] y');
    expect(redact('x abcdefghijk y', 'abcdefghijk')).toBe('x abcdefghijk y');
    expect(redact('a Stripe test-mode key (sk_test_ or rk_test_)', 'test')).toBe('a Stripe test-mode key (sk_test_ or rk_test_)');
    expect(redact('typed sk_test_abc123 here', 'abc')).toBe('typed [key] here');
  });

  it('leaves other text alone', () => {
    expect(redact('No such price: price_123', TEST_KEY)).toBe('No such price: price_123');
    expect(redact('nothing to hide', '')).toBe('nothing to hide');
  });
});

describe('mayReplace', () => {
  it('replaces a file that is not there, or that an earlier run wrote', () => {
    expect(mayReplace(null)).toBe(true);
    expect(mayReplace(`${OUTPUT_HEADER}\nX=1\n`)).toBe(true);
    expect(mayReplace(OUTPUT_HEADER)).toBe(true);
  });

  it('still recognises its own file when an editor put a byte order mark in front', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(mayReplace(`${bom}${OUTPUT_HEADER}\nX=1\n`)).toBe(true);
    expect(mayReplace(`${bom}something else\n`)).toBe(false);
  });

  it('leaves any other file alone, empty or not', () => {
    for (const other of ['', 'X=1\n', ` ${OUTPUT_HEADER}`, `x\n${OUTPUT_HEADER}\n`, OUTPUT_HEADER.slice(0, 10)]) {
      expect(mayReplace(other), other).toBe(false);
    }
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

  it('reads the name the path resolves to, so a trailing dot segment cannot hide it', () => {
    const hidden = [DOT_ENV, '.'].join(BACKSLASH);
    expect(parseArgs(['--out', hidden])).toEqual({
      error: `Refusing to write ${DOT_ENV}: a file named like an env file may hold secrets. Pick another name.`
    });
    for (const out of [`${DOT_ENV}/.`, `dir/../${DOT_ENV}.local`, [DOT_ENV, '..', `${DOT_ENV}.dev`].join(BACKSLASH)]) {
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

  function harness(account = fakeAccount(), existingFile: string | null = null) {
    const logs: string[] = [];
    const errors: string[] = [];
    const files: Array<{ path: string; text: string }> = [];
    const createPort = vi.fn(() => account.port);
    const readFile = vi.fn((_path: string): string | null => existingFile);
    const deps: Deps = {
      createPort,
      readFile,
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
    return { deps, logs, errors, files, createPort, readFile, account, everything };
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
    for (const key of [undefined, '', 'pk_test_abc', 'whsec_abc', ' sk_test_abc', 'sk_test_abc ']) {
      const h = harness();
      expect(await execute([], { STRIPE_SECRET_KEY: key }, h.deps), String(key)).toBe(2);
      expect(h.createPort).not.toHaveBeenCalled();
      expect(h.errors.join(' ')).toMatch(/test-mode key.*no spaces around it/);
    }
  });

  it('never echoes a key typed where an argument belongs, test or live', async () => {
    for (const typed of [`STRIPE_SECRET_KEY=${TEST_KEY}`, TEST_KEY, 'sk_live_51AbCdEfGhIjKl']) {
      const h = harness();
      expect(await execute([typed], env, h.deps), typed).toBe(2);
      expect(h.createPort).not.toHaveBeenCalled();
      expect(h.errors[0]).toContain('Unknown argument: ');
      expect(h.everything()).not.toContain(typed.replace('STRIPE_SECRET_KEY=', ''));
    }
    const noKey = harness();
    await execute([`STRIPE_SECRET_KEY=${TEST_KEY}`], {}, noKey.deps);
    expect(noKey.everything()).not.toContain(TEST_KEY);
  });

  it('refuses a key typed where the --out file name belongs, so it is never written as a name', async () => {
    // The last case is caught by the exact key alone: it has no Stripe key's shape.
    const cases: Array<[string, string]> = [
      [`${TEST_KEY}.txt`, TEST_KEY],
      ['sk_live_51AbCdEfGhIjKl', TEST_KEY],
      [`C:/prices/${TEST_KEY}`, TEST_KEY],
      ['pk_not_a_stripe_key_12345.txt', 'pk_not_a_stripe_key_12345']
    ];
    for (const [typed, key] of cases) {
      const h = harness();
      expect(await execute(['--out', typed], { STRIPE_SECRET_KEY: key }, h.deps), typed).toBe(2);
      expect(h.createPort).not.toHaveBeenCalled();
      expect(h.files).toEqual([]);
      expect(h.errors).toEqual(['--out must be a file name, and this one contains a key. Nothing was done.']);
      expect(h.everything()).not.toContain(typed);
    }
  });

  it('does not garble its messages when the key value is short junk', async () => {
    const h = harness();
    expect(await execute([], { STRIPE_SECRET_KEY: 'test' }, h.deps)).toBe(2);
    expect(h.errors).toEqual([
      'STRIPE_SECRET_KEY must be set to a Stripe test-mode key (sk_test_ or rk_test_), with no spaces around it.'
    ]);
  });

  it('tells the person not to run again after a live-mode Price, and otherwise that running again is safe', async () => {
    const live = harness();
    (live.account.port.createPrice as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new LiveModePriceError('price_live'));
    expect(await execute([], env, live.deps)).toBe(1);
    expect(live.errors[0]).toBe('Stopped: Stripe made a live-mode Price (price_live); stopping');
    expect(live.errors[1]).toBe(
      'Do not run this again with this key. Archive price_live in the Stripe dashboard and check which account the key belongs to.'
    );

    const plain = harness();
    (plain.account.port.createPrice as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
    expect(await execute([], env, plain.deps)).toBe(1);
    expect(plain.errors[1]).toBe('Running it again is safe: the prices already made are found and kept.');
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
    expect(h.files[0].text.startsWith(OUTPUT_HEADER)).toBe(true);
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
    expect(h.logs).toContain('prices.txt was left as it was: there are no prices to write.');
  });

  it('shows what was decided before a failure partway through', async () => {
    const h = harness();
    const find = h.account.port.findPrice as ReturnType<typeof vi.fn>;
    const original = find.getMockImplementation() as (lookupKey: string) => Promise<unknown>;
    let calls = 0;
    find.mockImplementation(async (lookupKey: string) => {
      calls += 1;
      if (calls === 3) throw new Error('network down');
      return original(lookupKey);
    });
    expect(await execute([], env, h.deps)).toBe(1);
    expect(h.logs).toHaveLength(2);
    expect(h.logs.every(line => line.startsWith('created '))).toBe(true);
    expect(h.errors[0]).toBe('Stopped: network down');
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

  it('shows the lines when the file cannot be written, since the Prices exist by then', async () => {
    const h = harness();
    h.deps.writeFile = () => {
      throw new Error(`EACCES: permission denied, key ${TEST_KEY}`);
    };
    expect(await execute(['--out', 'prices.txt'], env, h.deps)).toBe(1);
    expect(h.errors[0]).toBe('Could not write prices.txt: EACCES: permission denied, key [key]');
    for (const [i, product] of OPTIONS.entries()) expect(h.logs).toContain(`${product.priceEnv}=price_test_${i + 1}`);
    expect(h.everything()).not.toContain(TEST_KEY);
  });

  describe('the --out file', () => {
    it('is replaced when an earlier run wrote it', async () => {
      const h = harness(fakeAccount(), `${OUTPUT_HEADER}\nSTRIPE_JIT_OLD_PRICE_ID=price_old\n`);
      expect(await execute(['--out', 'prices.txt'], env, h.deps)).toBe(0);
      expect(h.files).toHaveLength(1);
    });

    it('is left alone when another program wrote it, before any request', async () => {
      for (const foreign of ['DATABASE_URL=postgres://example\n', '', `SOMETHING=1\n${OUTPUT_HEADER}\n`]) {
        const h = harness(fakeAccount(), foreign);
        expect(await execute(['--out', 'prices.txt'], env, h.deps), foreign).toBe(2);
        expect(h.createPort).not.toHaveBeenCalled();
        expect(h.files).toEqual([]);
        expect(h.errors[0]).toBe('prices.txt exists and was not written by this script, so it is left alone. Pick another name.');
      }
    });

    it('is reported when it cannot be read, before any request', async () => {
      const h = harness();
      h.deps.readFile = () => {
        throw new Error('EISDIR: illegal operation on a directory');
      };
      expect(await execute(['--out', 'somewhere'], env, h.deps)).toBe(2);
      expect(h.createPort).not.toHaveBeenCalled();
      expect(h.errors[0]).toBe('Cannot use somewhere: EISDIR: illegal operation on a directory');
    });

    it('is looked at in a dry run too, so looking first shows a path the real run would refuse', async () => {
      const dry = harness();
      expect(await execute(['--dry-run', '--out', 'prices.txt'], env, dry.deps)).toBe(0);
      expect(dry.readFile).toHaveBeenCalledWith('prices.txt');
      expect(dry.files).toEqual([]);

      const foreign = harness(fakeAccount(), 'SOMETHING=1\n');
      expect(await execute(['--dry-run', '--out', 'prices.txt'], env, foreign.deps)).toBe(2);
      expect(foreign.createPort).not.toHaveBeenCalled();
    });

    it('is not looked at when there is no --out', async () => {
      const plain = harness();
      await execute([], env, plain.deps);
      expect(plain.readFile).not.toHaveBeenCalled();
    });

    it('is replaced when an editor saved it with a byte order mark', async () => {
      const bom = String.fromCharCode(0xfeff);
      const h = harness(fakeAccount(), `${bom}${OUTPUT_HEADER}\nSTRIPE_JIT_OLD_PRICE_ID=price_old\n`);
      expect(await execute(['--out', 'prices.txt'], env, h.deps)).toBe(0);
      expect(h.files).toHaveLength(1);
    });
  });

  it('exits 2 on a usage error before it looks at the key', async () => {
    const h = harness();
    expect(await execute(['--nope'], {}, h.deps)).toBe(2);
    expect(h.createPort).not.toHaveBeenCalled();
    expect(h.errors).toEqual(['Unknown argument: --nope', USAGE]);
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Prices resolve lazily from Stripe (#275 stage A); /readyz reports whether
// any ENABLED product is currently unpriceable, and kicks a re-attempt when
// one is. Resolution itself is covered in priceCatalog.test.ts; this suite
// stubs the accessors to exercise the readiness wiring in BOTH directions -
// the failing branch had zero coverage in the first revision (#278 review).
const priceCatalog = vi.hoisted(() => ({
  unpriced: [] as Array<{ productCode: string; rule: string; diagnosticClass: string }>,
  ensureCalls: 0,
  lastEnv: undefined as NodeJS.ProcessEnv | undefined
}));
// The mock supplies DATA and never a verdict. An earlier version exported an
// isPriceCatalogCold() the suite could hand-set, which let a cold-start test
// pass against production code where that function could never return true
// (#278 review round 3). Coldness is now derived from the failure rules, which
// this mock reproduces faithfully because they are the catalog's own output.
vi.mock('../../../src/services/priceCatalog.js', () => ({
  getUnpricedProducts: (env?: NodeJS.ProcessEnv) => {
    priceCatalog.lastEnv = env;
    return priceCatalog.unpriced;
  },
  kickPriceCatalog: () => {
    priceCatalog.ensureCalls += 1;
  }
}));
import { readFile } from 'node:fs/promises';

/**
 * Issue #155: /readyz distinguishes "configured and able" from /healthz's
 * "process is up". These pin the report shape and its privacy contract: an
 * unauthenticated caller gets check names only - never a rule id, never a
 * configured value - while the detail goes to the server log.
 */

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../src/db/index.js', () => ({ query }));

import { getReadiness, resetReadinessCache } from '../../../src/mcp/readiness.js';

beforeEach(() => {
  priceCatalog.unpriced = [];
  priceCatalog.ensureCalls = 0;
  priceCatalog.lastEnv = undefined;
});

const READY_DEV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production', // deployed development runs NODE_ENV=production
  LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'development',
  DATABASE_URL: 'postgresql://user:pass@fixture.example/db',
  STRIPE_SECRET_KEY: 'sk_test_readyz_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_readyz_fixture'
};

const READY_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'production',
  DATABASE_URL: 'postgresql://user:pass@fixture.example/db',
  STRIPE_SECRET_KEY: 'sk_live_readyz_fixture',
  STRIPE_WEBHOOK_SECRET: 'whsec_readyz_fixture',
  STRIPE_PRICE_STARTER: 'price_starter_readyz',
  STRIPE_PRICE_REGULAR: 'price_regular_readyz',
  STRIPE_PRICE_POWER: 'price_power_readyz',
  LETTER_PROVIDER: 'postgrid',
  LETTER_PROVIDER_API_KEY: 'live_sk_readyz_fixture',
  LETTER_PROVIDER_CONFIG: '{"mode":"live"}',
  TEMP_IMAGE_STORE: 'bucket',
  TEMP_IMAGE_BUCKET_NAME: 'readyz-bucket',
  TEMP_IMAGE_BUCKET_ENDPOINT: 'https://bucket.fixture.example',
  TEMP_IMAGE_BUCKET_REGION: 'readyz-region',
  TEMP_IMAGE_BUCKET_ACCESS_KEY_ID: 'readyz-access-key',
  TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY: 'readyz-secret-key',
  LETTER_IRL_OAUTH_CIMD_ENFORCEMENT: 'true'
};

function routableDb(rows: Array<{ mail_type: string; provider: string }> = []): void {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('provider_routing')) return { rows };
    return { rows: [{ '?column?': 1 }] }; // SELECT 1
  });
}

describe('/readyz readiness report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReadinessCache();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reports ready with the mode and provider named for a healthy development deploy', async () => {
    routableDb([{ mail_type: 'postcard', provider: 'postgrid' }]);
    const report = await getReadiness(READY_DEV);
    expect(report.statusCode).toBe(200);
    expect(JSON.parse(report.body)).toEqual({
      ready: true,
      mode: 'development',
      provider: 'dummy', // LETTER_PROVIDER unset: the implicit default, made visible
      checks: { config: 'ok', database: 'ok', routing: 'ok', prices: 'ok' }
    });
  });

  it('reports ready for a fully configured production deploy', async () => {
    routableDb([{ mail_type: 'postcard', provider: 'postgrid' }]);
    const report = await getReadiness(READY_PROD);
    expect(report.statusCode).toBe(200);
    expect(JSON.parse(report.body)).toMatchObject({
      ready: true,
      mode: 'production',
      provider: 'postgrid'
    });
  });

  it('answers 503 naming only the failing check when configuration is invalid', async () => {
    routableDb();
    const broken = { ...READY_PROD, STRIPE_SECRET_KEY: 'sk_test_readyz_fixture' };
    const report = await getReadiness(broken);
    expect(report.statusCode).toBe(503);
    expect(JSON.parse(report.body)).toEqual({ ready: false, failing: ['config'] });
    // The wire body must not teach an anonymous caller what is wrong.
    expect(report.body).not.toContain('stripe');
    expect(report.body).not.toContain('live_key_required');
  });

  it('fails the database check when the database is unreachable', async () => {
    query.mockRejectedValue(new Error('connection refused to db.private.internal'));
    const report = await getReadiness(READY_DEV);
    expect(report.statusCode).toBe(503);
    const body = JSON.parse(report.body);
    expect(body.failing).toContain('database');
    expect(report.body).not.toContain('db.private.internal');
  });

  it('fails routing when production mail is routed to the dummy provider', async () => {
    // The check boot validation cannot make: provider_routing lives in the
    // database and overrides the environment.
    routableDb([{ mail_type: 'postcard', provider: 'dummy' }]);
    const report = await getReadiness(READY_PROD);
    expect(report.statusCode).toBe(503);
    expect(JSON.parse(report.body)).toEqual({ ready: false, failing: ['routing'] });
  });

  it('allows development to route to the dummy provider', async () => {
    routableDb([{ mail_type: 'postcard', provider: 'dummy' }]);
    const report = await getReadiness(READY_DEV);
    expect(report.statusCode).toBe(200);
  });

  it('fails routing when production mail is routed to DIY, which is registered but not approved', async () => {
    // DIY is manual print - an explicit operator act the runtime does not
    // refuse, but an environment routing production mail to it is not ready
    // and must say so (review round 1: only dummy was flagged).
    routableDb([{ mail_type: 'postcard', provider: 'diy' }]);
    const report = await getReadiness(READY_PROD);
    expect(report.statusCode).toBe(503);
    expect(JSON.parse(report.body)).toEqual({ ready: false, failing: ['routing'] });
  });

  it('never reflects an unrecognized LETTER_PROVIDER value to anonymous callers', async () => {
    // The route is unauthenticated; echoing an arbitrary env value would
    // serve anything accidentally pasted into LETTER_PROVIDER (review r1).
    routableDb([{ mail_type: 'postcard', provider: 'postgrid' }]);
    const pasted = { ...READY_DEV, LETTER_PROVIDER: 'accidentally-pasted-secret-9x7' };
    const report = await getReadiness(pasted);
    expect(report.statusCode).toBe(200);
    expect(JSON.parse(report.body).provider).toBe('unrecognized');
    expect(report.body).not.toContain('accidentally-pasted-secret-9x7');
  });

  it('is actually registered as a route in the HTTP server, before auth with /healthz', async () => {
    // getReadiness alone passing says nothing if the route block is deleted
    // (mutation gap from review round 1).
    const source = await readFile('src/mcp/httpServer.ts', 'utf8');
    const healthzIndex = source.indexOf('url.pathname === "/healthz"');
    const readyzIndex = source.indexOf('url.pathname === "/readyz"');
    expect(healthzIndex).toBeGreaterThan(-1);
    expect(readyzIndex).toBeGreaterThan(healthzIndex);
    const block = source.slice(readyzIndex, source.indexOf('return;', readyzIndex));
    expect(block).toContain('await getReadiness()');
    expect(block).toContain('readiness.statusCode');
  });

  it('fails routing on a routing row naming an unregistered provider, in any mode', async () => {
    routableDb([{ mail_type: 'postcard', provider: 'lob' }]);
    const report = await getReadiness(READY_DEV);
    expect(report.statusCode).toBe(503);
    expect(JSON.parse(report.body).failing).toEqual(['routing']);
  });

  it('never leaks configured secret values into either outcome body', async () => {
    routableDb([{ mail_type: 'postcard', provider: 'postgrid' }]);
    const ready = await getReadiness(READY_PROD);
    resetReadinessCache();
    query.mockRejectedValue(new Error('down'));
    const notReady = await getReadiness(READY_PROD);
    for (const body of [ready.body, notReady.body]) {
      expect(body).not.toContain('sk_live_readyz_fixture');
      expect(body).not.toContain('live_sk_readyz_fixture');
      expect(body).not.toContain('readyz-secret-key');
      expect(body).not.toContain('user:pass');
    }
  });

  it('memoizes the report briefly so polling cannot hammer the database', async () => {
    routableDb([{ mail_type: 'postcard', provider: 'postgrid' }]);
    await getReadiness(READY_DEV);
    const callsAfterFirst = query.mock.calls.length;
    await getReadiness(READY_DEV);
    expect(query.mock.calls.length).toBe(callsAfterFirst);
  });

  it('logs the failing rule ids for the operator instead of serving them', async () => {
    routableDb();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...READY_PROD, LETTER_PROVIDER: 'dummy' };
    await getReadiness(broken);
    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('"event":"readiness.failed"');
    expect(logged).toContain('provider.live_provider_required');
  });

  it('leaves the /healthz contract untouched: the body is still exactly "ok"', async () => {
    const source = await readFile('src/mcp/httpServer.ts', 'utf8');
    const healthz = source.slice(source.indexOf('url.pathname === "/healthz"'));
    expect(healthz.slice(0, healthz.indexOf('return;'))).toContain('res.end("ok")');
  });
});

describe('/readyz prices check (#275 stage A)', () => {
  beforeEach(() => {
    resetReadinessCache();
    routableDb([{ mail_type: 'letter', provider: 'postgrid' }]);
  });

  it('fails closed, naming only the check, when an enabled product is unpriced', async () => {
    // The failing branch had no coverage in the first revision - a refactor
    // dropping the prices entry from `failing` would have passed the suite.
    priceCatalog.unpriced = [
      { productCode: 'credit-pack-100', rule: 'price.inactive', diagnosticClass: 'configuration_error' }
    ];

    const report = await getReadiness(READY_PROD);

    expect(report.statusCode).toBe(503);
    const body = JSON.parse(report.body);
    expect(body.failing).toContain('prices');
    // Privacy contract: the unauthenticated body never carries a rule id or a
    // product code - those go to the server log.
    expect(report.body).not.toContain('price.inactive');
    expect(report.body).not.toContain('credit-pack-100');
  });

  it('kicks a re-attempt when failing, so a transient boot failure self-heals', async () => {
    priceCatalog.unpriced = [
      { productCode: 'credit-pack-4', rule: 'price.not_resolved', diagnosticClass: 'provider_error' }
    ];

    await getReadiness();

    expect(priceCatalog.ensureCalls).toBeGreaterThan(0);
  });

  it('does not touch the catalog resolver when healthy', async () => {
    const report = await getReadiness(READY_PROD);

    expect(report.statusCode).toBe(200);
    expect(JSON.parse(report.body).checks.prices).toBe('ok');
    expect(priceCatalog.ensureCalls).toBe(0);
  });

  it('keeps the ready-body checks object in step with the possible failing names', async () => {
    // The checks literal is hand-written; this guard stops a fifth check being
    // added to `failing` without appearing in the healthy body, or vice versa.
    const report = await getReadiness(READY_PROD);
    const checkNames = Object.keys(JSON.parse(report.body).checks).sort();
    expect(checkNames).toEqual(['config', 'database', 'prices', 'routing']);
  });

  it('names every failing-list entry in the healthy body too', async () => {
    // The reverse direction, which reading only the 200 body cannot see: a
    // `failing.push('newcheck')` with no matching key in the hand-written
    // `checks` literal passed the guard above untouched, and an operator got a
    // 503 naming a check that appears in no ready body and no documentation
    // (#278 review round 3). Read from source, like the route-registration
    // guard in this suite.
    const source = await readFile('src/mcp/readiness.ts', 'utf8');
    const pushed = [...source.matchAll(/failing\.push\('([a-z_]+)'\)/g)].map(m => m[1]).sort();
    const report = await getReadiness(READY_PROD);
    const checkNames = Object.keys(JSON.parse(report.body).checks).sort();

    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed).toEqual(checkNames);
  });

  it('kicks the resolver even for statically-unset prices', async () => {
    // The suppression this replaces gated the self-heal off exactly the
    // staleness it would have fixed: an id_not_configured recorded before the
    // env var was set kept suppressing the kick after it was. The catalog's
    // own cooldown ladder makes the kick a cheap synchronous no-op between
    // attempts, so unconditional is safe (#278 review round 5).
    priceCatalog.unpriced = [
      { productCode: 'credit-pack-4', rule: 'price.id_not_configured', diagnosticClass: 'configuration_error' }
    ];

    // No env argument: the kick is gated on the AMBIENT env, because it can
    // only heal process.env's catalog - kicking for a custom-env caller would
    // heal a different environment than the report described (#278 round 6).
    await getReadiness();

    expect(priceCatalog.ensureCalls).toBeGreaterThan(0);
  });

  it('suppresses the kick for a caller-supplied env it cannot heal', async () => {
    priceCatalog.unpriced = [
      { productCode: 'credit-pack-4', rule: 'price.lookup_failed', diagnosticClass: 'StripeConnectionError' }
    ];

    await getReadiness(READY_PROD);

    expect(priceCatalog.ensureCalls).toBe(0);
  });

  it('still re-attempts a fault that could clear on its own', async () => {
    priceCatalog.unpriced = [
      { productCode: 'credit-pack-4', rule: 'price.lookup_failed', diagnosticClass: 'StripeConnectionError' }
    ];

    await getReadiness();

    expect(priceCatalog.ensureCalls).toBeGreaterThan(0);
  });

  /**
   * The gate mirrors validateStripe: STRIPE_PRICE_* are requiredIn
   * 'production', downgraded to a warning outside it and skipped entirely in
   * test/admin. Without this gate a development deploy - where those variables
   * are legitimately unset, so every product is unpriced - answered 503
   * forever and could never pass the documented post-deploy check. The
   * READY_DEV fixture asserted prices:'ok' and passed anyway, because the
   * suite mocks this very module: the divergence was structurally invisible
   * (#278 review round 2).
   */
  it('does not fail a development deploy whose prices are legitimately unset', async () => {
    priceCatalog.unpriced = [
      { productCode: 'credit-pack-4', rule: 'price.id_not_configured', diagnosticClass: 'configuration_error' },
      { productCode: 'credit-pack-10', rule: 'price.id_not_configured', diagnosticClass: 'configuration_error' },
      { productCode: 'credit-pack-100', rule: 'price.id_not_configured', diagnosticClass: 'configuration_error' }
    ];

    const report = await getReadiness(READY_DEV);

    expect(report.statusCode).toBe(200);
    // Ready, but honest about it: 'ok' here would be a lie the operator reads
    // on the deploy check.
    expect(JSON.parse(report.body).checks.prices).toBe('degraded');
    expect(report.body).not.toContain('credit-pack-4');
  });

  it('leaves admin-mode production to the config check, not the prices one', async () => {
    // validateStripe skips its price rules under ADMIN_ENABLED, so the gate
    // here looked like it needed an admin term too. It does not:
    // admin.enabled_in_production is itself a config ERROR, so such a deploy
    // is already unready on `config` and an admin term in the prices gate
    // would be unreachable. Pinned so nobody re-adds the dead condition.
    priceCatalog.unpriced = [
      { productCode: 'credit-pack-4', rule: 'price.id_not_configured', diagnosticClass: 'configuration_error' }
    ];

    const report = await getReadiness({ ...READY_PROD, ADMIN_ENABLED: 'true' });

    expect(report.statusCode).toBe(503);
    expect(JSON.parse(report.body).failing).toContain('config');
  });

  it('holds an UNREADY verdict briefly, so a warming instance stops lying fast', async () => {
    // The few hundred ms between the port binding and a subsystem warming up.
    // Caching that verdict for the full 5s pinned a healthy instance at 503
    // across exactly the window the documented post-deploy check runs in, and
    // the body carries only a check name so it is indistinguishable from a real
    // fault (#278 review rounds 2 and 3).
    vi.useFakeTimers();
    try {
      priceCatalog.unpriced = [
        { productCode: 'credit-pack-4', rule: 'price.not_resolved', diagnosticClass: 'provider_error' }
      ];
      expect((await getReadiness(READY_PROD)).statusCode).toBe(503);

      // The warmup lands.
      priceCatalog.unpriced = [];
      vi.advanceTimersByTime(2_100);
      const recovered = await getReadiness(READY_PROD);

      expect(recovered.statusCode).toBe(200);
      expect(JSON.parse(recovered.body).checks.prices).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the same short hold to a database fault, not just a price one', async () => {
    // Stated generally on purpose: the pg pool opening its first connection
    // has the same warmup shape as the catalog, and an earlier attempt that
    // special-cased prices covered neither it nor routing.
    vi.useFakeTimers();
    try {
      query.mockRejectedValue(new Error('still connecting'));
      expect((await getReadiness(READY_PROD)).statusCode).toBe(503);

      routableDb([{ mail_type: 'letter', provider: 'postgrid' }]);
      vi.advanceTimersByTime(2_100);

      expect((await getReadiness(READY_PROD)).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still caches the unready verdict, so /readyz is never an open database probe', async () => {
    // Shorter is not uncached: the route is unauthenticated, and each miss
    // costs two database round-trips.
    vi.useFakeTimers();
    try {
      priceCatalog.unpriced = [
        { productCode: 'credit-pack-4', rule: 'price.inactive', diagnosticClass: 'configuration_error' }
      ];
      expect((await getReadiness(READY_PROD)).statusCode).toBe(503);
      const callsAfterFirst = query.mock.calls.length;

      priceCatalog.unpriced = [];
      vi.advanceTimersByTime(500);

      expect((await getReadiness(READY_PROD)).statusCode).toBe(503);
      expect(query.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes the cache expiry from the clock AFTER the checks, not before', async () => {
    // The database and routing checks can take seconds (5s pool connect
    // timeout, a Neon wake retry). An expiry computed from the entry
    // timestamp was already in the past by the time it was written whenever
    // the checks took longer than the TTL - the memo dead on arrival, and
    // /readyz re-ran two database round-trips per probe in exactly the
    // slow-database failure mode the cache exists to bound (#278 round 4).
    vi.useFakeTimers();
    try {
      priceCatalog.unpriced = [
        { productCode: 'credit-pack-4', rule: 'price.inactive', diagnosticClass: 'configuration_error' }
      ];
      query.mockImplementation(async (sql: string) => {
        // The checks themselves consume 3s - longer than the 1s unready TTL.
        vi.advanceTimersByTime(3_000);
        if (sql.includes('provider_routing')) return { rows: [{ mail_type: 'letter', provider: 'postgrid' }] };
        return { rows: [{ '?column?': 1 }] };
      });

      expect((await getReadiness(READY_PROD)).statusCode).toBe(503);
      const callsAfterFirst = query.mock.calls.length;

      // 500ms later - inside the post-checks TTL. Must serve the memo.
      vi.advanceTimersByTime(500);
      expect((await getReadiness(READY_PROD)).statusCode).toBe(503);
      expect(query.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a steady failing verdict once, not once per recompute', async () => {
    // At the short unready TTL an unconditional readiness.failed line was up
    // to ~43,000 identical entries a day on a probed instance - the flood
    // shape every other diagnostic in this file already dedupes (#278 r5).
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      priceCatalog.unpriced = [
        { productCode: 'credit-pack-4', rule: 'price.inactive', diagnosticClass: 'configuration_error' }
      ];

      await getReadiness(READY_PROD);
      vi.advanceTimersByTime(2_100);
      await getReadiness(READY_PROD);
      vi.advanceTimersByTime(2_100);
      await getReadiness(READY_PROD);

      const emitted = diagnostic.mock.calls
        .flat()
        .map(String)
        .filter(line => line.includes('"event":"readiness.failed"'));
      expect(emitted).toHaveLength(1);
    } finally {
      diagnostic.mockRestore();
      vi.useRealTimers();
    }
  });

  it("asks the catalog about the CALLER'S env, not ambient process.env", async () => {
    // Every other check in the report reads the env parameter; a prices
    // verdict computed from process.env stitched a report from two different
    // environments - a 503 naming prices that no variable in the supplied env
    // explained (#278 review round 5).
    await getReadiness(READY_PROD);

    expect(priceCatalog.lastEnv).toBe(READY_PROD);
  });

  it('does not re-log when only the ORDER of routing offenders changes', async () => {
    // The offenders come from an ORDER BY-less query, so a heap-order flip
    // between probes changed the dedupe signature with no state change and
    // re-emitted the line the dedupe exists to suppress (#278 round 6).
    vi.useFakeTimers();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let flip = false;
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('provider_routing')) {
          const rows = [
            { mail_type: 'letter', provider: 'ghost-a' },
            { mail_type: 'postcard', provider: 'ghost-b' }
          ];
          return { rows: flip ? [...rows].reverse() : rows };
        }
        return { rows: [{ '?column?': 1 }] };
      });

      await getReadiness(READY_PROD);
      flip = true;
      vi.advanceTimersByTime(2_100);
      await getReadiness(READY_PROD);

      const emitted = diagnostic.mock.calls
        .flat()
        .map(String)
        .filter(line => line.includes('"event":"readiness.failed"'));
      expect(emitted).toHaveLength(1);
    } finally {
      diagnostic.mockRestore();
      vi.useRealTimers();
    }
  });

  it('caches a READY verdict for the full TTL', async () => {
    vi.useFakeTimers();
    try {
      expect((await getReadiness(READY_PROD)).statusCode).toBe(200);

      priceCatalog.unpriced = [
        { productCode: 'credit-pack-4', rule: 'price.inactive', diagnosticClass: 'configuration_error' }
      ];
      vi.advanceTimersByTime(1_500);

      // Still the memoized 200: only unready verdicts get the short hold.
      expect((await getReadiness(READY_PROD)).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

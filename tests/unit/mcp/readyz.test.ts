import { beforeEach, describe, expect, it, vi } from 'vitest';

// Prices resolve from Stripe at boot (#275 stage A) and /readyz reports whether
// they did. That is a separate concern from the checks this suite exercises, so
// it is stubbed here and covered directly in priceCatalog.test.ts.
const priceCatalog = vi.hoisted(() => ({ loaded: true }));
vi.mock('../../../src/services/priceCatalog.js', () => ({
  isPriceCatalogLoaded: () => priceCatalog.loaded,
  getPriceCatalogFailures: () => (priceCatalog.loaded ? [] : ['price.lookup_failed'])
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
  STRIPE_STARTER_AMOUNT_CENTS: '500',
  STRIPE_PRICE_REGULAR: 'price_regular_readyz',
  STRIPE_REGULAR_AMOUNT_CENTS: '1000',
  STRIPE_PRICE_POWER: 'price_power_readyz',
  STRIPE_POWER_AMOUNT_CENTS: '9000',
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

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  databaseTlsPosture,
  validateDeploymentConfig
} from '../../../src/config/deploymentConfig.js';

/**
 * Database TLS (#157).
 *
 * The issue recorded this as "production is the only environment without
 * certificate verification", from
 *
 *   ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
 *
 * That reading was wrong, and so were the first two fixes attempted for it.
 *
 * node-postgres merges the parsed connection string OVER the explicit config,
 * so wherever a URL carries an sslmode this key is discarded entirely. With a
 * Neon URL, true, false and undefined all resolve to the same {} - and because
 * pg-connection-string only applies libpq's "encrypt but do not verify"
 * meaning when uselibpqcompat is set, that {} reaches tls.connect with
 * rejectUnauthorized at Node's default of true. Production has been verifying
 * certificates all along.
 *
 * The option is live in exactly one shape: a URL with NO sslmode. There the
 * string sets nothing, the option applies, and it said false. The bare
 * fallback URL an operator is most likely to paste was the one connection that
 * skipped verification.
 *
 * Which rules out both simpler fixes. Flipping the value is not a no-op, as it
 * first appears - it is the fix for that one shape. And deleting the option is
 * actively worse there: with no sslmode and no option, pg resolves ssl to
 * false and the connection drops to PLAINTEXT.
 *
 * So the first describe tests node-postgres itself. Every claim above is load
 * bearing, and asserting a restatement of it would pin the belief rather than
 * the behaviour.
 */

const NEON = 'postgresql://u:p@ep-x.aws.neon.tech/db?sslmode=require&channel_binding=require';
const NO_SSLMODE = 'postgresql://postgres:pw@host/t';

/** The ssl config a Client will actually use. */
function effectiveSsl(config: Record<string, unknown>): unknown {
  return (new pg.Client(config as never) as unknown as {
    connectionParameters: { ssl: unknown };
  }).connectionParameters.ssl;
}

describe('what node-postgres actually does', () => {
  it('DISCARDS an explicit ssl option when the URL carries sslmode', () => {
    // pg/lib/connection-parameters.js:
    //   Object.assign({}, config, parse(config.connectionString))
    // The parsed string is second, so it wins.
    const withTrue = effectiveSsl({ connectionString: NEON, ssl: { rejectUnauthorized: true } });
    const withFalse = effectiveSsl({ connectionString: NEON, ssl: { rejectUnauthorized: false } });
    const withNone = effectiveSsl({ connectionString: NEON });

    expect(withFalse).toEqual(withTrue);
    expect(withFalse).toEqual(withNone);
  });

  it('leaves sslmode=require as {}, which Node verifies by default', () => {
    // pg then passes this to tls.connect adding only servername, and Node
    // defaults rejectUnauthorized to true - so {} is full verification,
    // hostname included.
    expect(effectiveSsl({ connectionString: NEON })).toEqual({});
  });

  it('applies the option in the ONE shape that matters: no sslmode', () => {
    // Why the value had to change rather than be deleted.
    expect(effectiveSsl({ connectionString: NO_SSLMODE, ssl: { rejectUnauthorized: true } })).toEqual(
      { rejectUnauthorized: true }
    );
    // What the old code did here.
    expect(
      effectiveSsl({ connectionString: NO_SSLMODE, ssl: { rejectUnauthorized: false } })
    ).toEqual({ rejectUnauthorized: false });
    // And why deleting the option would have been worse than either.
    expect(effectiveSsl({ connectionString: NO_SSLMODE })).toBe(false);
  });

  it('keeps a plaintext local URL on plaintext outside production', () => {
    // What CI and local development rely on: the option is only passed when
    // NODE_ENV is production, so a plaintext test database still connects.
    expect(effectiveSsl({ connectionString: 'postgresql://postgres:pw@localhost:5432/t' })).toBe(
      false
    );
  });
});

describe('databaseTlsPosture', () => {
  it.each([['require'], ['verify-full'], ['verify-ca']])(
    'treats sslmode=%s as verified',
    mode => {
      expect(databaseTlsPosture(`postgresql://u:p@h/db?sslmode=${mode}`)).toMatchObject({
        encrypted: true,
        verified: true
      });
    }
  );

  it('flags a URL with no sslmode as unencrypted', () => {
    expect(databaseTlsPosture('postgresql://u:p@h/db')).toMatchObject({
      encrypted: false,
      verified: false
    });
  });

  it('flags sslmode=disable as unencrypted', () => {
    expect(databaseTlsPosture('postgresql://u:p@h/db?sslmode=disable')).toMatchObject({
      encrypted: false
    });
  });

  it('flags sslmode=no-verify as encrypted but unverified', () => {
    expect(databaseTlsPosture('postgresql://u:p@h/db?sslmode=no-verify')).toMatchObject({
      encrypted: true,
      verified: false
    });
  });

  it('flags uselibpqcompat, which changes what require MEANS', () => {
    // The forward-looking half. The option exists in pg today and is where the
    // library is heading; a default flip would silently disable verification
    // on a URL nobody edited.
    expect(
      databaseTlsPosture('postgresql://u:p@h/db?sslmode=require&uselibpqcompat=true')
    ).toMatchObject({ encrypted: true, verified: false });
    expect(
      databaseTlsPosture('postgresql://u:p@h/db?sslmode=prefer&uselibpqcompat=true')
    ).toMatchObject({ verified: false });
  });

  it('reports an unparseable URL rather than guessing', () => {
    expect(databaseTlsPosture('not a url')).toMatchObject({ unparseable: true });
  });

  it('reports a missing URL', () => {
    expect(databaseTlsPosture(undefined)).toMatchObject({ encrypted: false });
  });
});

describe('the production boot rule', () => {
  const PROD: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'production',
    DATABASE_URL: 'postgresql://user:pass@fixture.example/db?sslmode=require',
    STRIPE_SECRET_KEY: 'sk_live_unit_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_unit_fixture',
    STRIPE_PRICE_STARTER: 'price_starter_unit_fixture',
    STRIPE_PRICE_REGULAR: 'price_regular_unit_fixture',
    STRIPE_PRICE_POWER: 'price_power_unit_fixture',
    LETTER_PROVIDER: 'postgrid',
    LETTER_PROVIDER_API_KEY: 'live_sk_unit_fixture',
    LETTER_PROVIDER_CONFIG: '{"mode":"live"}',
    LETTER_IRL_ALLOWED_HOSTS: 'api.fixture.example',
    LETTER_IRL_ALLOWED_ORIGINS: 'https://chatgpt.com'
  };

  const rules = (overrides: Record<string, string | undefined>) =>
    validateDeploymentConfig({ ...PROD, ...overrides }, 'server').findings.map(f => f.rule);

  it('passes a real Neon-shaped URL', () => {
    expect(rules({})).not.toContain('database.tls_required');
    expect(rules({})).not.toContain('database.tls_verification_required');
  });

  it('refuses a URL with no sslmode', () => {
    // The option makes this connection verified, but the rule still refuses
    // it: relying on a fallback that only works because of one merge quirk is
    // not a posture, and the URL should say what it means.
    expect(rules({ DATABASE_URL: 'postgresql://u:p@h/db' })).toContain('database.tls_required');
  });

  it('refuses an unverified connection', () => {
    // The option cannot fix this one - sslmode wins the merge - so the rule is
    // the only thing standing between production and an unverified database.
    expect(rules({ DATABASE_URL: 'postgresql://u:p@h/db?sslmode=no-verify' })).toContain(
      'database.tls_verification_required'
    );
  });

  it('refuses libpq compatibility, which downgrades require', () => {
    expect(
      rules({ DATABASE_URL: 'postgresql://u:p@h/db?sslmode=require&uselibpqcompat=true' })
    ).toContain('database.tls_verification_required');
  });

  it('WARNS rather than refuses on an unparseable URL', () => {
    // pg accepts connection strings the WHATWG parser rejects. Refusing to
    // boot over a URL that works would be a fresh way for production to fail
    // on its own strictness - a trap this repo has hit before.
    const validation = validateDeploymentConfig({ ...PROD, DATABASE_URL: 'weird' }, 'server');
    expect(validation.findings.map(f => f.rule)).toContain('database.tls_unknown');
    expect(validation.errors.join(' ')).not.toContain('TLS mode is unknown');
  });

  it('does not apply outside production', () => {
    const dev = validateDeploymentConfig(
      {
        NODE_ENV: 'production',
        LETTER_IRL_DEPLOYMENT_ENVIRONMENT: 'development',
        DATABASE_URL: 'postgresql://u:p@h/db',
        STRIPE_SECRET_KEY: 'sk_test_unit_fixture',
        STRIPE_WEBHOOK_SECRET: 'whsec_unit_fixture'
      },
      'server'
    );
    expect(dev.findings.map(f => f.rule)).not.toContain('database.tls_required');
  });

  it('applies to the maintenance surface too', () => {
    // Both services connect to the database, so this is not gated on
    // surface === 'server' the way the HTTP allowlists are.
    const maintenance = validateDeploymentConfig(
      { ...PROD, DATABASE_URL: 'postgresql://u:p@h/db' },
      'maintenance'
    );
    expect(maintenance.findings.map(f => f.rule)).toContain('database.tls_required');
  });
});

describe('both pools ask for verification', () => {
  it.each(['src/db/index.ts', 'src/cli/migrate.ts'])(
    '%s passes rejectUnauthorized: true, never false',
    file => {
      // Textual, and paired with the behavioural tests above rather than
      // standing alone. Reverting this value is silent everywhere except the
      // no-sslmode fallback - the one case it breaks - so nothing else would
      // catch it. Comments are stripped first, because they discuss the old
      // value by name.
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      expect(body).toMatch(/rejectUnauthorized:\s*true/);
      expect(body).not.toMatch(/rejectUnauthorized:\s*false/);
    }
  );
});

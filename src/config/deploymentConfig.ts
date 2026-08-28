/**
 * Centralized deployment configuration validation. Issue #155.
 *
 * Why this exists: a deploy missing STRIPE_PRICE_STARTER booted
 * cleanly, passed /healthz, and failed only when a customer clicked Buy Now
 * (issue #213) - and the provider layer is worse: in production a missing
 * PostGrid key silently dispatches real sends to the dummy provider. A healthy
 * deployment that quietly does not do its job is worse than a startup failure,
 * so production configuration is validated before the server accepts traffic
 * and before maintenance touches anything.
 *
 * Shape follows src/auth/oauthConfig.ts: pure functions over an injectable
 * env, every problem collected (not first-failure), and a throwing assert
 * wrapper for the boot path. Finding messages never contain values - only
 * variable names and what was expected of them.
 *
 * ENV_VAR_MANIFEST doubles as the machine-readable inventory of deploy-time
 * variables. scripts/preflight-cutover.ts diffs it against each Railway
 * environment before promotion, so the validator and the preflight can never
 * disagree about what production requires.
 */

import {
  JIT_PRICE_ENV_VARS,
  PACK_PRICE_ENV_VARS,
  normalizedCurrency,
  packCurrency
} from './products.js';
import { isDebugEnabled } from '../utils/debug.js';

export type DeploymentMode = 'production' | 'development' | 'test';

export type ValidationSurface = 'server' | 'maintenance';

export interface ConfigFinding {
  severity: 'error' | 'warning';
  /** Stable machine-readable id, e.g. "provider.live_mode_required". */
  rule: string;
  /** Human message. Never contains a configured value. */
  message: string;
}

export interface DeploymentValidation {
  mode: DeploymentMode;
  findings: ConfigFinding[];
  errors: string[];
  warnings: string[];
}

export interface EnvVarRequirement {
  name: string;
  /** Alternative names that satisfy the requirement (bucket alias chains). */
  aliases?: readonly string[];
  requiredIn: 'always' | 'production' | 'development';
  condition?: 'unless-admin' | 'when-jit-enabled' | 'when-static-dcr';
  /**
   * Listed so the cutover preflight can DIFF it, but absence is not a failure:
   * the code has a working default. `checkedBy` alone was not enough - it only
   * exempts an entry from the boot-time presence loop, and the preflight reads
   * `requiredIn`/`condition` and nothing else, so adding STRIPE_CURRENCY turned
   * `preflight:cutover` red for a correctly configured USD production
   * environment - "a fresh way for production to refuse", which the entry's own
   * comment claimed to be avoiding (#278 review round 3).
   */
  advisory?: boolean;
  /** True when the value is a credential; drives placeholder detection. */
  secret: boolean;
  services: ReadonlyArray<'api' | 'maintenance'>;
  /**
   * Rule id that owns this variable's validation. Entries with an owner are
   * skipped by the generic presence check so a missing variable is reported
   * exactly once, by its dedicated rule. Ownerless entries get the generic
   * "X is required" presence error.
   */
  checkedBy?: string;
}

/**
 * Providers approved to fulfill production mail unattended. 'dummy' fakes
 * success and is refused outright in production (boot rule + runtime guard).
 * 'diy' is manual print: a provider_routing row naming it is treated as an
 * explicit operator act and is not refused at runtime, but /readyz reports the
 * environment not-ready while it stands, so it can never be the silent state.
 * 'lob' is display-name-only and never registered.
 */
export const APPROVED_LIVE_PROVIDERS = ['postgrid'] as const;

/**
 * Price ids only. The amounts used to live alongside them as
 * STRIPE_*_AMOUNT_CENTS - a second copy of a figure Stripe already owns, which
 * could drift from it silently (#275). They now resolve from the Price itself,
 * so there is one number and nothing to keep in step. The env-name lists come
 * from the same product table the resolver reads (src/config/products.ts), so
 * "must be set" and "must resolve" cannot name different variables.
 */

/**
 * Every PostGrid credential the provider layer can read. SEND-capable keys
 * dispatch real mail; the address-verification key can only verify addresses,
 * so a live one outside production is a cost concern, never a mail-safety
 * one - dev has legitimately run live address verification all along, and the
 * first deployed boot of this validator proved it by refusing to start.
 */
const PROVIDER_SEND_KEY_VARS = ['LETTER_PROVIDER_API_KEY', 'POSTGRID_API_KEY'] as const;
const PROVIDER_VERIFY_KEY_VARS = ['POSTGRID_ADDRESS_VERIFICATION_API_KEY'] as const;
const PROVIDER_KEY_VARS = [...PROVIDER_SEND_KEY_VARS, ...PROVIDER_VERIFY_KEY_VARS] as const;

export const ENV_VAR_MANIFEST: readonly EnvVarRequirement[] = [
  {
    name: 'DATABASE_URL',
    requiredIn: 'always',
    secret: true,
    services: ['api', 'maintenance']
  },
  {
    name: 'STRIPE_SECRET_KEY',
    requiredIn: 'always',
    condition: 'unless-admin',
    secret: true,
    services: ['api', 'maintenance']
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    requiredIn: 'always',
    condition: 'unless-admin',
    secret: true,
    services: ['api']
  },
  {
    name: 'LETTER_IRL_DEPLOYMENT_ENVIRONMENT',
    requiredIn: 'production',
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'env.deployment_environment_required'
  },
  {
    // services: ['api'] only. The maintenance cron serves no HTTP, so it has no
    // Host or Origin to allowlist - and listing it here would make the preflight
    // demand a variable that service cannot use.
    name: 'LETTER_IRL_ALLOWED_HOSTS',
    requiredIn: 'production',
    secret: false,
    services: ['api'],
    checkedBy: 'http.allowed_hosts_required'
  },
  {
    name: 'LETTER_IRL_ALLOWED_ORIGINS',
    requiredIn: 'production',
    secret: false,
    services: ['api'],
    checkedBy: 'http.allowed_origins_required'
  },
  {
    name: 'LETTER_PROVIDER',
    requiredIn: 'production',
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'provider.live_provider_required'
  },
  {
    name: 'LETTER_PROVIDER_API_KEY',
    requiredIn: 'production',
    secret: true,
    services: ['api', 'maintenance'],
    checkedBy: 'provider.api_key_required'
  },
  {
    name: 'LETTER_PROVIDER_CONFIG',
    requiredIn: 'production',
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'provider.live_mode_required'
  },
  ...PACK_PRICE_ENV_VARS.map((price): EnvVarRequirement => ({
    name: price,
    requiredIn: 'production',
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'stripe.pack_price_incomplete'
  })),
  ...JIT_PRICE_ENV_VARS.map((price): EnvVarRequirement => ({
    name: price,
    requiredIn: 'production',
    condition: 'when-jit-enabled',
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'stripe.jit_config_incomplete'
  })),
  /**
   * The currencies are here because #275 made them load-bearing. Every Price
   * must be denominated in its product's expected currency or the catalog
   * refuses to price it, which in production is a 503 and a refused purchase -
   * so an unset STRIPE_CURRENCY silently defaulting to 'usd' can brick a GBP
   * deployment. They appeared in no manifest entry, no validator rule, and no
   * doc, so `preflight:cutover` reported full parity while the two
   * environments disagreed and nothing an operator could read named the
   * variable at fault (#278 review round 2).
   *
   * checkedBy keeps this a WARNING rather than a new hard boot requirement:
   * the default is correct for this deployment, and the point is visibility to
   * the preflight's name diff, not a fresh way for production to refuse to
   * start on the eve of a cutover.
   */
  {
    name: 'STRIPE_CURRENCY',
    requiredIn: 'production',
    condition: 'unless-admin',
    advisory: true,
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'stripe.currency_unset'
  },
  {
    name: 'JIT_CURRENCY',
    requiredIn: 'production',
    condition: 'when-jit-enabled',
    advisory: true,
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'stripe.currency_unset'
  },
  /**
   * OAuth configuration (issue #270).
   *
   * These are owned by validateOAuthConfig (src/auth/oauthConfig.ts), hence
   * checkedBy - so the generic presence pass stays silent and boot behaviour is
   * unchanged by their arrival here. The point of listing them is the OTHER
   * consumer: scripts/preflight-cutover.ts reads the manifest to diff a
   * Railway environment before promotion, and could not see a single OAuth
   * variable. Production diverges more here than anywhere else, and neither
   * check could report it - the preflight because the names were absent from
   * this list, the validator because assertValidOAuthConfig only runs when
   * LETTER_IRL_OAUTH_CIMD_ENFORCEMENT is enabled, which production does not set
   * (#158).
   *
   * Presence is all the preflight can judge: it reads names, never values, by a
   * deliberate privacy contract. So this catches an absent issuer, not a wrong
   * one. A wrong-but-present value is the validator's job, which is why
   * LETTER_IRL_OAUTH_CIMD_ENFORCEMENT is itself required in production below.
   *
   * None are secrets: issuer URLs, audiences, scope lists, and public client
   * ids are all published in metadata, so they stay out of the placeholder scan.
   */
  ...(
    [
      'LETTER_IRL_OAUTH_ISSUER',
      'LETTER_IRL_OAUTH_AUTH_ENDPOINT',
      'LETTER_IRL_OAUTH_TOKEN_ENDPOINT',
      'LETTER_IRL_OAUTH_JWKS_URI',
      'LETTER_IRL_OAUTH_AUDIENCE'
    ] as const
  ).map((name): EnvVarRequirement => ({
    name,
    requiredIn: 'always',
    secret: false,
    services: ['api'],
    checkedBy: 'oauth.config_required'
  })),
  {
    // Falls back to LETTER_IRL_PUBLIC_BASE_URL + LETTER_IRL_MCP_PATH when
    // unset (getOAuthConfig), so either name satisfies the requirement - the
    // same alias-chain shape the bucket entries use. Production relies on the
    // fallback today and is correct to.
    name: 'LETTER_IRL_MCP_RESOURCE',
    aliases: ['LETTER_IRL_PUBLIC_BASE_URL'],
    requiredIn: 'always',
    secret: false,
    services: ['api'],
    checkedBy: 'oauth.config_required'
  },
  {
    // Environment isolation: validateOAuthConfig pins the issuer against the
    // matching allowlist and errors without it. Production has never had it set.
    name: 'LETTER_IRL_OAUTH_PROD_ISSUER',
    requiredIn: 'production',
    secret: false,
    services: ['api'],
    checkedBy: 'oauth.config_required'
  },
  {
    name: 'LETTER_IRL_OAUTH_DEV_ISSUER',
    requiredIn: 'development',
    secret: false,
    services: ['api'],
    checkedBy: 'oauth.config_required'
  },
  {
    // Not configuration but the switch that makes the configuration checked:
    // without it assertValidOAuthConfig never runs and a misconfigured
    // production boots clean and serves a broken OAuth surface (#158). Required
    // in production so the preflight reports its absence as the cutover gap it
    // is. It gates nothing at boot by design - a server that refused to start
    // over its own strictness flag would be a worse failure than the one it
    // guards against.
    name: 'LETTER_IRL_OAUTH_CIMD_ENFORCEMENT',
    requiredIn: 'production',
    secret: false,
    services: ['api'],
    checkedBy: 'oauth.config_required'
  },
  ...(
    ['CHATGPT_STATIC_CLIENT_ID', 'CHATGPT_STATIC_REDIRECT_URIS'] as const
  ).map((name): EnvVarRequirement => ({
    // Only meaningful in the static-DCR rollback shape, and required outright
    // there - validateOAuthConfig errors on either being absent when the
    // compatibility flag is on. Keyed off the flag NAME being present, matching
    // how when-jit-enabled is interpreted: the preflight cannot read values, and
    // a set-but-false flag is worth surfacing before a cutover anyway.
    name,
    requiredIn: 'always',
    condition: 'when-static-dcr',
    secret: false,
    services: ['api'],
    checkedBy: 'oauth.config_required'
  })),
  {
    name: 'TEMP_IMAGE_BUCKET_NAME',
    aliases: ['AWS_S3_BUCKET_NAME', 'BUCKET'],
    requiredIn: 'production',
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'bucket.config_required'
  },
  {
    name: 'TEMP_IMAGE_BUCKET_ENDPOINT',
    aliases: ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL', 'ENDPOINT'],
    requiredIn: 'production',
    secret: false,
    services: ['api', 'maintenance'],
    checkedBy: 'bucket.config_required'
  },
  {
    name: 'TEMP_IMAGE_BUCKET_ACCESS_KEY_ID',
    aliases: ['AWS_ACCESS_KEY_ID', 'ACCESS_KEY_ID'],
    requiredIn: 'production',
    secret: true,
    services: ['api', 'maintenance'],
    checkedBy: 'bucket.config_required'
  },
  {
    name: 'TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY',
    aliases: ['AWS_SECRET_ACCESS_KEY', 'SECRET_ACCESS_KEY'],
    requiredIn: 'production',
    secret: true,
    services: ['api', 'maintenance'],
    checkedBy: 'bucket.config_required'
  }
];

function resolveAliased(
  requirement: Pick<EnvVarRequirement, 'name' | 'aliases'>,
  env: NodeJS.ProcessEnv
): string | undefined {
  for (const name of [requirement.name, ...(requirement.aliases ?? [])]) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve which environment this process believes it is.
 *
 * LETTER_IRL_DEPLOYMENT_ENVIRONMENT is the identity signal and wins when set.
 * NODE_ENV cannot serve as identity because both Railway environments run
 * NODE_ENV=production (deployed development needs it for Neon SSL and bucket
 * enforcement) - but NODE_ENV=production without the identity label resolves
 * to production anyway, because an unlabeled production-built deploy must get
 * the full production rules, plus an error demanding the label. Unrecognized
 * identity values also fail closed to production.
 *
 * ACCEPTED RESIDUAL RISK, named deliberately: the identity label is trusted.
 * A production service mislabeled "development" skips every production rule.
 * The cross-signal that catches the likely version of that mistake is the
 * pair of live-key-outside-production rules - a mislabeled service still
 * carrying its live Stripe or PostGrid keys fails boot loudly. What remains
 * uncaught is a service mislabeled AND fully populated with development
 * config; it would serve dummy fulfillment, though test-mode Stripe cannot
 * charge real cards. Catching that would require an out-of-band signal
 * (e.g. Railway environment identity) that the process does not have.
 */
export function resolveDeploymentMode(
  env: NodeJS.ProcessEnv = process.env
): { mode: DeploymentMode; findings: ConfigFinding[] } {
  const identity = env.LETTER_IRL_DEPLOYMENT_ENVIRONMENT;
  const nodeEnv = env.NODE_ENV;
  const findings: ConfigFinding[] = [];

  if (identity === 'production') {
    if (nodeEnv !== 'production') {
      findings.push({
        severity: 'error',
        rule: 'env.node_env_mismatch',
        message:
          'LETTER_IRL_DEPLOYMENT_ENVIRONMENT=production requires NODE_ENV=production'
      });
    }
    return { mode: 'production', findings };
  }
  if (identity === 'development') {
    // Deployed development intentionally runs NODE_ENV=production; not a
    // contradiction.
    return { mode: 'development', findings };
  }
  if (identity) {
    findings.push({
      severity: 'error',
      rule: 'env.deployment_environment_invalid',
      message:
        'LETTER_IRL_DEPLOYMENT_ENVIRONMENT must be "production" or "development"'
    });
    return { mode: 'production', findings };
  }
  if (nodeEnv === 'production') {
    findings.push({
      severity: 'error',
      rule: 'env.deployment_environment_required',
      message:
        'LETTER_IRL_DEPLOYMENT_ENVIRONMENT is required when NODE_ENV=production'
    });
    return { mode: 'production', findings };
  }
  if (nodeEnv === 'test') {
    return { mode: 'test', findings };
  }
  return { mode: 'development', findings };
}

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveDeploymentMode(env).mode === 'production';
}

function isPlaceholder(value: string): boolean {
  return value.includes('...') || /^(your[_-]|changeme|placeholder|xxx)/i.test(value);
}

function validateProvider(
  env: NodeJS.ProcessEnv,
  mode: DeploymentMode,
  findings: ConfigFinding[]
): void {
  const provider = env.LETTER_PROVIDER;
  const production = mode === 'production';

  if (production) {
    // Unset is rejected explicitly: getLetterProvider() defaults an unset
    // LETTER_PROVIDER to 'dummy' (src/services/providers/index.ts), which is
    // the exact silent-fake-fulfillment failure this module exists to stop.
    if (!provider || !APPROVED_LIVE_PROVIDERS.includes(provider.toLowerCase() as never)) {
      findings.push({
        severity: 'error',
        rule: 'provider.live_provider_required',
        message: `LETTER_PROVIDER must be an approved live provider (${APPROVED_LIVE_PROVIDERS.join(', ')}) in production`
      });
    }
    if (!env.LETTER_PROVIDER_API_KEY) {
      findings.push({
        severity: 'error',
        rule: 'provider.api_key_required',
        message: 'LETTER_PROVIDER_API_KEY is required in production'
      });
    }
  }

  const configJson = env.LETTER_PROVIDER_CONFIG;
  let parsedMode: unknown;
  let parseFailed = false;
  if (configJson) {
    try {
      const parsed: unknown = JSON.parse(configJson);
      parsedMode =
        parsed && typeof parsed === 'object' ? (parsed as { mode?: unknown }).mode : undefined;
    } catch {
      parseFailed = true;
      findings.push({
        severity: production ? 'error' : 'warning',
        rule: 'provider.config_json_invalid',
        message: 'LETTER_PROVIDER_CONFIG is not valid JSON'
      });
    }
  }
  // The provider layer defaults a missing mode to 'test' in two places, so an
  // absent config or absent mode is a test-mode production deploy.
  if (production && !parseFailed && parsedMode !== 'live') {
    findings.push({
      severity: 'error',
      rule: 'provider.live_mode_required',
      message: 'LETTER_PROVIDER_CONFIG must be JSON with "mode": "live" in production'
    });
  }

  for (const keyVar of PROVIDER_KEY_VARS) {
    const value = env[keyVar];
    if (!value) continue;
    // A live SEND key outside production can dispatch real mail: error. A
    // live VERIFICATION key outside production only spends verification
    // credits: warn, don't refuse - dev intentionally verifies against live
    // address data because test-mode verification returns canned results.
    const sendCapable = (PROVIDER_SEND_KEY_VARS as readonly string[]).includes(keyVar);
    if (production && value.startsWith('test_')) {
      findings.push({
        severity: 'error',
        rule: 'provider.test_key_in_production',
        message: `${keyVar} is a test-mode key; production requires a live key`
      });
    } else if (!production && value.startsWith('live_')) {
      findings.push({
        severity: sendCapable ? 'error' : 'warning',
        rule: 'provider.live_key_outside_production',
        message: sendCapable
          ? `${keyVar} is a live-mode key; only production may hold one`
          : `${keyVar} is a live-mode key; verification-only, so permitted outside production, but be aware it spends real verification credits`
      });
    } else if (production && !value.startsWith('live_')) {
      findings.push({
        severity: 'warning',
        rule: 'provider.key_prefix_unrecognized',
        message: `${keyVar} does not carry a recognized live_/test_ prefix; verify it is a live key`
      });
    }
  }
}

function validateStripe(
  env: NodeJS.ProcessEnv,
  mode: DeploymentMode,
  findings: ConfigFinding[]
): void {
  const production = mode === 'production';
  const adminMode = env.ADMIN_ENABLED === 'true';

  const secretKey = env.STRIPE_SECRET_KEY;
  if (secretKey) {
    const live = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
    if (production && !live) {
      findings.push({
        severity: 'error',
        rule: 'stripe.live_key_required',
        message: 'STRIPE_SECRET_KEY must be a live-mode key (sk_live_/rk_live_) in production'
      });
    } else if (!production && live) {
      // The mirror-image guard: a live key outside production can charge real
      // cards from a development deploy.
      findings.push({
        severity: 'error',
        rule: 'stripe.live_key_outside_production',
        message: 'STRIPE_SECRET_KEY is a live-mode key; only production may hold one'
      });
    }
  }

  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) {
    findings.push({
      severity: production ? 'error' : 'warning',
      rule: 'stripe.webhook_secret_malformed',
      message: 'STRIPE_WEBHOOK_SECRET does not look like a Stripe webhook secret (whsec_...)'
    });
  }

  // Packs are always sellable, so their config is checked whenever this is a
  // deployed environment. Test mode skips it: unit fixtures configure only
  // what they exercise.
  if (mode !== 'test' && !adminMode) {
    for (const price of PACK_PRICE_ENV_VARS) {
      const problems: string[] = [];
      // TRIMMED, exactly like the catalog that will resolve it: #275 made
      // products.ts trim every price id, and judging the raw value here made
      // a pasted leading space a production BOOT error for an id the runtime
      // resolves and sells. Development boots and sells packs normally,
      // promotion crash-loops the API, and the message tells the operator
      // that a value plainly beginning with price_ is not a price id -
      // preflight is names-only, so nothing between them catches it. The
      // same trim-vs-raw split round 5 fixed for STRIPE_CURRENCY and round 7
      // for order currencies (#278 round 9).
      const priceValue = (env[price] ?? '').trim();
      if (!priceValue) problems.push(`${price} is required`);
      else if (!priceValue.startsWith('price_')) problems.push(`${price} must be a Stripe price id (price_...)`);
      for (const message of problems) {
        findings.push({
          severity: production ? 'error' : 'warning',
          rule: 'stripe.pack_price_incomplete',
          message
        });
      }
    }

    // The store currency stopped being decorative in #275: every Price must be
    // denominated in it or the catalog refuses to price that product, so an
    // unset value defaulting to 'usd' can make an otherwise correct
    // non-USD deployment unsellable with nothing naming the cause. A warning,
    // not an error - the default is right for this deployment and production
    // must not gain a new way to refuse to boot - but it is now something an
    // operator can read (#278 review round 2).
    // Trimmed: a whitespace-only value (a paste artifact in a Railway field)
    // is "set" to the falsy check but unset to the catalog, which silently
    // validated every Price against usd with zero findings (#278 review r5).
    // Via the SAME normalizer the runtime uses, so the validator's notion of
    // "unset" cannot drift from products.ts's (#278 round 6).
    if (normalizedCurrency(env.STRIPE_CURRENCY, '') === '') {
      // Names every product family that inherits it. Round 10 deduped the
      // two currency findings by DELETING the JIT one, so with Pay & Send
      // enabled and both vars unset the operator read a pack-only warning,
      // fixed packs, and still had Pay & Send failing on a terminal
      // currency_mismatch nothing had mentioned (#278 round 11).
      const alsoJit = env.JIT_PURCHASE_ENABLED === 'true' &&
        normalizedCurrency(env.JIT_CURRENCY, '') === '';
      findings.push({
        severity: 'warning',
        rule: 'stripe.currency_unset',
        message:
          `STRIPE_CURRENCY is not set; ${alsoJit ? 'pack and Pay & Send' : 'pack'} ` +
          'Prices must be denominated in the default (usd) or they will not resolve'
      });
    }

    if (env.JIT_PURCHASE_ENABLED === 'true') {
      for (const price of JIT_PRICE_ENV_VARS) {
        const problems: string[] = [];
        // Trimmed, like the catalog - see the pack loop above (#278 round 9).
        const priceValue = (env[price] ?? '').trim();
        if (!priceValue) problems.push(`${price} is required when JIT_PURCHASE_ENABLED=true`);
        else if (!priceValue.startsWith('price_')) problems.push(`${price} must be a Stripe price id (price_...)`);
        for (const message of problems) {
          findings.push({
            severity: production ? 'error' : 'warning',
            rule: 'stripe.jit_config_incomplete',
            message
          });
        }
      }
      // Only when JIT_CURRENCY alone is missing: the both-unset case is
      // already reported by the pack check above, under this same rule id, so
      // firing here too gave one root cause two findings with conflicting
      // text under one rule (#278 round 10).
      if (
        normalizedCurrency(env.JIT_CURRENCY, '') === '' &&
        normalizedCurrency(env.STRIPE_CURRENCY, '') !== ''
      ) {
        // The message is rendered FROM the predicate. Round 10 narrowed this
        // branch to "JIT_CURRENCY alone is unset" but left text asserting
        // that STRIPE_CURRENCY was unset too and that Prices must be in usd -
        // both false on the only branch that can now reach it, and a non-USD
        // operator following it would point Pay & Send at USD Prices and get
        // a terminal currency_mismatch (#278 round 11).
        findings.push({
          severity: 'warning',
          rule: 'stripe.currency_unset',
          message:
            `JIT_CURRENCY is not set; Pay & Send Prices must be denominated in ` +
            `${packCurrency(env)}, inherited from STRIPE_CURRENCY`
        });
      }
    }
  }
}

function validateBucket(
  env: NodeJS.ProcessEnv,
  mode: DeploymentMode,
  findings: ConfigFinding[]
): void {
  if (mode !== 'production') return;

  // Mirrors src/services/tempImageStore.ts storageMode()/bucketConfig(), which
  // fail lazily on the first image operation. Promoted here to boot time; the
  // lazy check stays as defense in depth.
  if (env.TEMP_IMAGE_STORE === 'memory') {
    findings.push({
      severity: 'error',
      rule: 'bucket.config_required',
      message: 'TEMP_IMAGE_STORE=memory is not allowed in production'
    });
    return;
  }

  const bucketEntries = ENV_VAR_MANIFEST.filter(entry => entry.checkedBy === 'bucket.config_required');
  for (const entry of bucketEntries) {
    if (!resolveAliased(entry, env)) {
      findings.push({
        severity: 'error',
        rule: 'bucket.config_required',
        message: `${entry.name} (or an accepted alias) is required in production`
      });
    }
  }

  const region =
    env.TEMP_IMAGE_BUCKET_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || env.REGION;
  if (!region) {
    findings.push({
      severity: 'warning',
      rule: 'bucket.region_defaulted',
      message: 'No bucket region configured; the image store will default to "auto"'
    });
  }
}

function validatePlaceholders(env: NodeJS.ProcessEnv, findings: ConfigFinding[]): void {
  // Secret manifest entries, plus the optional provider keys the send path
  // prefers over the validated one (POSTGRID_API_KEY outranks
  // LETTER_PROVIDER_API_KEY in getProviderByName) - a placeholder there boots
  // clean and then fails every send (review round 1).
  const candidates: Array<Pick<EnvVarRequirement, 'name' | 'aliases'>> = [
    ...ENV_VAR_MANIFEST.filter(entry => entry.secret),
    ...PROVIDER_KEY_VARS.map(name => ({ name }))
  ];
  const reported = new Set<string>();
  for (const entry of candidates) {
    if (reported.has(entry.name)) continue;
    const value = resolveAliased(entry, env);
    if (value && isPlaceholder(value)) {
      // Catches .env.example's literal "sk_live_..." pasted into a real
      // environment. An unmistakably fake credential is an error everywhere.
      reported.add(entry.name);
      findings.push({
        severity: 'error',
        rule: 'config.placeholder_value',
        message: `${entry.name} appears to hold a placeholder value, not a real credential`
      });
    }
  }
}

/**
 * What TLS a DATABASE_URL will actually get (#157).
 *
 * The obvious reading of `src/db/index.ts` was that production ran without
 * certificate verification, because it passed
 *
 *   ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
 *
 * That line was DEAD CODE, and the conclusion drawn from it was wrong.
 * node-postgres merges a parsed connection string OVER the explicit config -
 * `Object.assign({}, config, parse(config.connectionString))` in
 * pg/lib/connection-parameters.js - so whenever the URL carries an `sslmode`
 * parameter, whatever `ssl` the caller passed is discarded. Verified against
 * pg 8.16.3: with a Neon URL, `rejectUnauthorized` true, false and undefined
 * all produce exactly the same effective config.
 *
 * And that effective config is `{}`. pg-connection-string only applies libpq's
 * semantics - where `require` means "encrypt but do not verify" - when
 * `uselibpqcompat` is set. It is not set here, so `sslmode=require` falls
 * through its switch unchanged, leaving `ssl = {}`. pg then hands that to
 * tls.connect adding only `servername`, and Node defaults `rejectUnauthorized`
 * to true. So production HAS been verifying certificates, including the
 * hostname, all along.
 *
 * Which makes this a latent fault rather than an open one, and changes what
 * needs fixing. Two things silently turn verification off:
 *
 *   1. A DATABASE_URL with NO sslmode parameter. Then pg never sets ssl from
 *      the string, the explicit option DOES apply, and in production that
 *      option said `rejectUnauthorized: false`. The fallback case - the one
 *      where an operator pastes a bare URL - was the one case that skipped
 *      verification. That option is now deleted.
 *   2. `uselibpqcompat=true` in the URL, which switches `require` and `prefer`
 *      to libpq's unverified meaning. The option exists in pg today and is
 *      where the library is heading, so a future default flip would silently
 *      disable verification on a URL nobody edited.
 *
 * Hence a check rather than a setting: the safe state is already the default,
 * and what it needs is something that notices when it stops being.
 */
export interface DatabaseTlsPosture {
  /** Whether the connection will be encrypted at all. */
  encrypted: boolean;
  /** Whether the server certificate and hostname will be verified. */
  verified: boolean;
  /** Present when the URL could not be parsed. */
  unparseable?: boolean;
  /** Short explanation, for the finding message. */
  detail: string;
}

/**
 * Mirrors pg-connection-string's NON-libpq branch, which is the one this
 * process runs. Kept deliberately close to that switch so the two can be
 * compared line by line if pg's behaviour ever changes.
 */
export function databaseTlsPosture(connectionString?: string): DatabaseTlsPosture {
  if (!connectionString) {
    return { encrypted: false, verified: false, detail: 'no DATABASE_URL is set' };
  }

  let params: URLSearchParams;
  try {
    params = new URL(connectionString).searchParams;
  } catch {
    // A warning, not an error. pg accepts connection strings the WHATWG URL
    // parser rejects, and refusing to boot over a URL that works would be a
    // fresh way for production to fail on its own strictness.
    return {
      encrypted: false,
      verified: false,
      unparseable: true,
      detail: 'DATABASE_URL could not be parsed, so its TLS mode is unknown'
    };
  }

  const sslmode = params.get('sslmode');
  const libpqCompat = (params.get('uselibpqcompat') || '').toLowerCase() === 'true';

  if (!sslmode) {
    // pg leaves ssl unset, which for a deployed database means plaintext.
    return {
      encrypted: false,
      verified: false,
      detail: 'DATABASE_URL sets no sslmode, so the connection is not encrypted'
    };
  }

  if (sslmode === 'disable') {
    return { encrypted: false, verified: false, detail: 'sslmode=disable turns TLS off' };
  }

  if (sslmode === 'no-verify') {
    return {
      encrypted: true,
      verified: false,
      detail: 'sslmode=no-verify encrypts but does not check the certificate'
    };
  }

  if (libpqCompat && (sslmode === 'require' || sslmode === 'prefer')) {
    return {
      encrypted: true,
      verified: false,
      detail:
        'uselibpqcompat=true gives sslmode=' + sslmode + ' its libpq meaning, which skips verification'
    };
  }

  if (sslmode === 'prefer') {
    // Encrypted and verified as pg behaves today, but the name promises a
    // silent downgrade to plaintext and libpq compat would make it unverified.
    return {
      encrypted: true,
      verified: true,
      detail: 'sslmode=prefer verifies today, but its name allows a downgrade'
    };
  }

  return { encrypted: true, verified: true, detail: 'sslmode=' + sslmode + ' verifies the certificate' };
}

export function validateDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
  surface: ValidationSurface = 'server'
): DeploymentValidation {
  const { mode, findings } = resolveDeploymentMode(env);
  const production = mode === 'production';
  const adminMode = env.ADMIN_ENABLED === 'true';

  // Generic presence pass over manifest entries that no dedicated rule owns.
  // Semantics preserved from the original httpServer loops: DATABASE_URL in
  // every mode; Stripe presence in every mode unless local admin mode.
  // The surface maps to the manifest's services field, so the validator and
  // the preflight parity script demand the same set per service - review
  // round 1 found them disagreeing about STRIPE_WEBHOOK_SECRET on the
  // maintenance cron, which never verifies a webhook.
  const service = surface === 'maintenance' ? 'maintenance' : 'api';
  for (const entry of ENV_VAR_MANIFEST) {
    if (entry.checkedBy) continue;
    if (!entry.services.includes(service)) continue;
    if (entry.requiredIn === 'production' && !production) continue;
    // Symmetric to the line above. Without it a development-only entry would
    // be demanded in production, which is the opposite of what it means.
    if (entry.requiredIn === 'development' && production) continue;
    if (entry.condition === 'unless-admin' && adminMode) continue;
    if (entry.condition === 'when-jit-enabled' && env.JIT_PURCHASE_ENABLED !== 'true') continue;
    if (
      entry.condition === 'when-static-dcr' &&
      env.LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY !== 'true'
    ) {
      continue;
    }
    if (!resolveAliased(entry, env)) {
      findings.push({
        severity: 'error',
        rule: `presence.${entry.name.toLowerCase()}`,
        message: `${entry.name} is required`
      });
    }
  }

  if (production && adminMode) {
    // The server has its own throwing guard for this; repeating it here covers
    // the maintenance surface, which has no such guard.
    findings.push({
      severity: 'error',
      rule: 'admin.enabled_in_production',
      message: 'ADMIN_ENABLED=true is not allowed in production'
    });
  }

  validateProvider(env, mode, findings);
  // Not gated on admin mode: the key-location rules must fire everywhere. A
  // pasted sk_live_ key in local admin tooling is exactly the "live key
  // outside production" scenario the rule exists for (review round 1). The
  // pack/JIT completeness checks inside are admin-gated individually.
  validateStripe(env, mode, findings);
  validateBucket(env, mode, findings);
  validatePlaceholders(env, findings);

  if (production && surface === 'server') {
    // The origin/host allowlists have LOCALHOST fallbacks, and an unset one is
    // silent in opposite and equally bad ways (#157):
    //
    //   LETTER_IRL_ALLOWED_HOSTS unset -> the allowlist is 0.0.0.0/localhost,
    //     which is handed to the MCP transports with
    //     enableDnsRebindingProtection: true. Every request to the real
    //     hostname is then rejected - while /healthz and /readyz, which are
    //     plain routes outside the transport, keep answering 200. So the
    //     promotion's own success check passes on a deployment that serves
    //     nothing. That is the worst shape a failure can have.
    //
    //   LETTER_IRL_ALLOWED_ORIGINS unset -> production CORS allowlists
    //     http://localhost:4173 and :8090. Fails open rather than closed.
    //
    // Neither variable is in the preflight manifest, so nothing else catches
    // them. Errors rather than warnings: the fallbacks are development
    // conveniences and there is no production configuration in which either
    // being absent is correct.
    if (!env.LETTER_IRL_ALLOWED_HOSTS?.trim()) {
      findings.push({
        severity: 'error',
        rule: 'http.allowed_hosts_required',
        message:
          'LETTER_IRL_ALLOWED_HOSTS is required in production; the localhost fallback ' +
          'makes DNS-rebinding protection reject every request to the public hostname ' +
          'while /readyz still reports healthy'
      });
    }
    if (!env.LETTER_IRL_ALLOWED_ORIGINS?.trim()) {
      findings.push({
        severity: 'error',
        rule: 'http.allowed_origins_required',
        message:
          'LETTER_IRL_ALLOWED_ORIGINS is required in production; the fallback allowlists ' +
          'localhost origins'
      });
    }
    if (env.LETTER_IRL_REQUIRE_AUTH === 'false') {
      findings.push({
        severity: 'warning',
        rule: 'auth.enforcement_disabled_in_production',
        message: 'LETTER_IRL_REQUIRE_AUTH=false leaves production unauthenticated'
      });
    } else if (env.LETTER_IRL_OAUTH_CIMD_ENFORCEMENT !== 'true') {
      // Warning, not error: the CIMD cutover is deliberately staged (#160);
      // escalation to an error is tracked on the release-readiness issue.
      findings.push({
        severity: 'warning',
        rule: 'auth.enforcement_disabled_in_production',
        message:
          'LETTER_IRL_OAUTH_CIMD_ENFORCEMENT is not enabled; OAuth configuration is not strictly validated at boot'
      });
    }
  }

  if (production) {
    // Both surfaces connect to the database, so this is NOT gated on
    // surface === 'server' the way the HTTP allowlists are.
    const tls = databaseTlsPosture(env.DATABASE_URL);
    if (tls.unparseable) {
      findings.push({
        severity: 'warning',
        rule: 'database.tls_unknown',
        message: tls.detail
      });
    } else if (!tls.encrypted) {
      findings.push({
        severity: 'error',
        rule: 'database.tls_required',
        message: tls.detail + '; production carries customer content and must use TLS'
      });
    } else if (!tls.verified) {
      findings.push({
        severity: 'error',
        rule: 'database.tls_verification_required',
        message:
          tls.detail + '; an unverified connection cannot tell the real database from an impostor'
      });
    }
  }

  if (production) {
    // Debug flags, graduated by what each actually exposes rather than by the
    // word "debug" (#157).
    //
    // DEBUG is an ERROR because it does not merely add logging: it un-404s
    // /debug/widgets, an UNAUTHENTICATED route that answers with
    // Access-Control-Allow-Origin: * and discloses the widget directory,
    // process.cwd() and absolute container paths. A route that should not
    // exist in production is not a verbosity setting, and unsetting the
    // variable fixes it in seconds.
    if (isDebugEnabled(env.DEBUG)) {
      findings.push({
        severity: 'error',
        rule: 'debug.enabled_in_production',
        message:
          'DEBUG is enabled, which serves the unauthenticated /debug/widgets route and discloses container paths'
      });
    }

    // These two only widen log records - counts and image parameter shapes, no
    // letter content - so they warn. Worth reporting because nothing else
    // would: neither appears in ENV_VAR_MANIFEST, so the cutover preflight
    // cannot see them either way.
    for (const name of ['DEBUG_CONTENT', 'DEBUG_IMAGE'] as const) {
      if (env[name] === 'true') {
        findings.push({
          severity: 'warning',
          rule: 'debug.verbose_logging_in_production',
          message: name + ' is enabled in production, which widens what reaches the logs'
        });
      }
    }
  }

  if (mode === 'development' && !env.LETTER_IRL_DEPLOYMENT_ENVIRONMENT) {
    const provider = env.LETTER_PROVIDER;
    if (!provider || provider.toLowerCase() === 'dummy') {
      findings.push({
        severity: 'warning',
        rule: 'provider.dummy_implicit_environment',
        message:
          'Running the dummy mail provider in an unlabeled environment; set LETTER_IRL_DEPLOYMENT_ENVIRONMENT=development to make this explicit'
      });
    }
  }

  return {
    mode,
    findings,
    errors: findings.filter(f => f.severity === 'error').map(f => f.message),
    warnings: findings.filter(f => f.severity === 'warning').map(f => f.message)
  };
}

export function assertValidDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
  surface: ValidationSurface = 'server'
): DeploymentValidation {
  const validation = validateDeploymentConfig(env, surface);
  if (validation.errors.length > 0) {
    // Carry the truthful class so any catch that logs this (the maintenance
    // failure diagnostic, notably) names configuration instead of defaulting
    // to a category that points at the wrong subsystem - the #213 trap.
    throw Object.assign(
      new Error(`Invalid deployment configuration:\n- ${validation.errors.join('\n- ')}`),
      { diagnosticClass: 'configuration_error' }
    );
  }
  return validation;
}

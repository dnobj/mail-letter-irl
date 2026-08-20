/**
 * Centralized deployment configuration validation. Issue #155.
 *
 * Why this exists: a deploy missing STRIPE_STARTER_AMOUNT_CENTS booted
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
  requiredIn: 'always' | 'production';
  condition?: 'unless-admin' | 'when-jit-enabled';
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

const PACK_PRICE_VARS = [
  { price: 'STRIPE_PRICE_STARTER', amount: 'STRIPE_STARTER_AMOUNT_CENTS' },
  { price: 'STRIPE_PRICE_REGULAR', amount: 'STRIPE_REGULAR_AMOUNT_CENTS' },
  { price: 'STRIPE_PRICE_POWER', amount: 'STRIPE_POWER_AMOUNT_CENTS' }
] as const;

const JIT_VARS = [
  { price: 'STRIPE_JIT_LETTER_PRICE_ID', amount: 'JIT_LETTER_AMOUNT_CENTS' },
  { price: 'STRIPE_JIT_POSTCARD_PRICE_ID', amount: 'JIT_POSTCARD_AMOUNT_CENTS' }
] as const;

/** Every PostGrid credential the provider layer can read. */
const PROVIDER_KEY_VARS = [
  'LETTER_PROVIDER_API_KEY',
  'POSTGRID_API_KEY',
  'POSTGRID_ADDRESS_VERIFICATION_API_KEY'
] as const;

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
  ...PACK_PRICE_VARS.flatMap(({ price, amount }): EnvVarRequirement[] => [
    {
      name: price,
      requiredIn: 'production',
      secret: false,
      services: ['api', 'maintenance'],
      checkedBy: 'stripe.pack_price_incomplete'
    },
    {
      name: amount,
      requiredIn: 'production',
      secret: false,
      services: ['api', 'maintenance'],
      checkedBy: 'stripe.pack_price_incomplete'
    }
  ]),
  ...JIT_VARS.flatMap(({ price, amount }): EnvVarRequirement[] => [
    {
      name: price,
      requiredIn: 'production',
      condition: 'when-jit-enabled',
      secret: false,
      services: ['api', 'maintenance'],
      checkedBy: 'stripe.jit_config_incomplete'
    },
    {
      name: amount,
      requiredIn: 'production',
      condition: 'when-jit-enabled',
      secret: false,
      services: ['api', 'maintenance'],
      checkedBy: 'stripe.jit_config_incomplete'
    }
  ]),
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

function isPositiveInteger(value: string | undefined): boolean {
  return value !== undefined && /^[1-9]\d*$/.test(value.trim());
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
    if (production && value.startsWith('test_')) {
      findings.push({
        severity: 'error',
        rule: 'provider.test_key_in_production',
        message: `${keyVar} is a test-mode key; production requires a live key`
      });
    } else if (!production && value.startsWith('live_')) {
      findings.push({
        severity: 'error',
        rule: 'provider.live_key_outside_production',
        message: `${keyVar} is a live-mode key; only production may hold one`
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
    for (const { price, amount } of PACK_PRICE_VARS) {
      const problems: string[] = [];
      const priceValue = env[price];
      if (!priceValue) problems.push(`${price} is required`);
      else if (!priceValue.startsWith('price_')) problems.push(`${price} must be a Stripe price id (price_...)`);
      if (!isPositiveInteger(env[amount])) {
        problems.push(`${amount} must be a positive integer of cents`);
      }
      for (const message of problems) {
        findings.push({
          severity: production ? 'error' : 'warning',
          rule: 'stripe.pack_price_incomplete',
          message
        });
      }
    }

    if (env.JIT_PURCHASE_ENABLED === 'true') {
      for (const { price, amount } of JIT_VARS) {
        const problems: string[] = [];
        const priceValue = env[price];
        if (!priceValue) problems.push(`${price} is required when JIT_PURCHASE_ENABLED=true`);
        else if (!priceValue.startsWith('price_')) problems.push(`${price} must be a Stripe price id (price_...)`);
        if (!isPositiveInteger(env[amount])) {
          problems.push(`${amount} must be a positive integer of cents when JIT_PURCHASE_ENABLED=true`);
        }
        for (const message of problems) {
          findings.push({
            severity: production ? 'error' : 'warning',
            rule: 'stripe.jit_config_incomplete',
            message
          });
        }
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
    if (entry.condition === 'unless-admin' && adminMode) continue;
    if (entry.condition === 'when-jit-enabled' && env.JIT_PURCHASE_ENABLED !== 'true') continue;
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

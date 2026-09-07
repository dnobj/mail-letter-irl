import { OperatorLoginSchema } from "./contracts.js";
import { AdminConfigurationError } from "./errors.js";

/**
 * The hosted admin panel is configured by Railway variables, validated here
 * once at boot. Every rule names the variable it is about and never its
 * value; the problems array is printed to the deploy log by the entrypoint.
 *
 * The environment identity comes from LETTER_IRL_DEPLOYMENT_ENVIRONMENT like
 * every other service, and everything environment-specific (the tag, the
 * hostname, the database role names) is derived from it, so a development
 * panel cannot be configured with production names by editing one variable.
 */

export type AdminEnvironment = "development" | "production";
export type AdminMode = "read-only" | "full";
export type AdminTailscaleMode = "daemon" | "local-dev";

export interface AdminRuntimeConfig {
  environment: AdminEnvironment;
  shortEnvironment: "dev" | "prod";
  mode: AdminMode;
  operatorLogins: readonly string[];
  tailscale: {
    mode: AdminTailscaleMode;
    hostname: string;
    tag: string;
    stateDir: string;
    stateFile: string;
    socketPath: string;
    authKey?: string;
    localDevLogin?: string;
  };
  appPort: number;
  healthPort: number;
  sessionSecret: string;
  /** Base32, validated; null only in read-only mode. */
  totpSecret: string | null;
  readerDatabaseUrl: string;
  readerRole: string;
  operatorDatabaseUrl: string | null;
  operatorRole: string;
  databaseHostname: string;
  databaseName: string;
  stripeKeyMode: "live" | "test" | "absent";
  stripeKeyRestricted: boolean;
  letterProvider: string;
  buildCommit: string;
  buildBranch: string;
  session: {
    idleTtlMs: number;
    absoluteTtlMs: number;
    elevationTtlMs: number;
    elevationMaxFailures: number;
    elevationFailureWindowMs: number;
  };
  packRefundCommandEnabled: boolean;
}

const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BASE32_PATTERN = /^[A-Z2-7]+=*$/;

interface ParsedDatabaseUrl {
  hostname: string;
  database: string;
  role: string;
}

function parseDatabaseUrl(value: string | undefined): ParsedDatabaseUrl | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      return null;
    }
    return {
      hostname: url.hostname.toLowerCase(),
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      role: decodeURIComponent(url.username),
    };
  } catch {
    return null;
  }
}

function parsePort(
  value: string | undefined,
  fallback: number,
  problems: string[],
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`${name} must be an integer port`);
    return fallback;
  }
  return port;
}

/** Decoded length of a base32 secret, or -1 when it is not base32. */
export function base32Length(secret: string): number {
  const normalized = secret.replace(/\s+/g, "").toUpperCase();
  if (!BASE32_PATTERN.test(normalized)) return -1;
  const unpadded = normalized.replace(/=+$/, "");
  return Math.floor((unpadded.length * 5) / 8);
}

export function parseAdminRuntimeConfig(
  env: NodeJS.ProcessEnv,
): AdminRuntimeConfig {
  const problems: string[] = [];

  const identity = env.LETTER_IRL_DEPLOYMENT_ENVIRONMENT;
  const environment: AdminEnvironment =
    identity === "development" ? "development" : "production";
  if (identity !== "development" && identity !== "production") {
    problems.push(
      'LETTER_IRL_DEPLOYMENT_ENVIRONMENT must be "development" or "production"',
    );
  }
  if (environment === "production" && env.NODE_ENV !== "production") {
    problems.push(
      "LETTER_IRL_DEPLOYMENT_ENVIRONMENT=production requires NODE_ENV=production",
    );
  }
  const shortEnvironment = environment === "production" ? "prod" : "dev";

  const modeValue = env.ADMIN_MODE ?? "read-only";
  const mode: AdminMode = modeValue === "full" ? "full" : "read-only";
  if (modeValue !== "read-only" && modeValue !== "full") {
    problems.push('ADMIN_MODE must be "read-only" or "full"');
  }

  const operatorLogins = (env.ADMIN_OPERATOR_LOGINS ?? "")
    .split(",")
    .map((login) => login.trim())
    .filter((login) => login.length > 0);
  if (operatorLogins.length === 0) {
    problems.push("ADMIN_OPERATOR_LOGINS must list at least one login");
  } else if (operatorLogins.length > 20) {
    problems.push("ADMIN_OPERATOR_LOGINS lists more than 20 logins");
  } else {
    for (const login of operatorLogins) {
      if (!OperatorLoginSchema.safeParse(login).success) {
        problems.push(
          "ADMIN_OPERATOR_LOGINS contains an entry that is not a tailnet login",
        );
        break;
      }
    }
    if (new Set(operatorLogins).size !== operatorLogins.length) {
      problems.push("ADMIN_OPERATOR_LOGINS contains a duplicate");
    }
  }

  const readerRole = `letter_irl_admin_reader_${environment}`;
  const operatorRole = `letter_irl_admin_operator_${environment}`;
  const reader = parseDatabaseUrl(env.ADMIN_READER_DATABASE_URL);
  if (!reader) {
    problems.push("ADMIN_READER_DATABASE_URL must be a PostgreSQL URL");
  } else if (reader.role !== readerRole) {
    problems.push(`ADMIN_READER_DATABASE_URL must connect as ${readerRole}`);
  }
  const primary = parseDatabaseUrl(env.DATABASE_URL);
  if (!primary) {
    problems.push("DATABASE_URL must be a PostgreSQL URL");
  } else {
    const expectedRole = mode === "full" ? operatorRole : readerRole;
    if (primary.role !== expectedRole) {
      problems.push(
        `DATABASE_URL must connect as ${expectedRole} in ${mode} mode`,
      );
    }
    if (reader && primary.hostname !== reader.hostname) {
      problems.push(
        "DATABASE_URL and ADMIN_READER_DATABASE_URL must name the same host",
      );
    }
    if (reader && primary.database !== reader.database) {
      problems.push(
        "DATABASE_URL and ADMIN_READER_DATABASE_URL must name the same database",
      );
    }
  }

  const sessionSecret = env.ADMIN_SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) {
    problems.push("ADMIN_SESSION_SECRET must be at least 32 characters");
  }
  const totpRaw = env.ADMIN_TOTP_SECRET ?? "";
  let totpSecret: string | null = null;
  if (totpRaw) {
    if (base32Length(totpRaw) < 16) {
      problems.push(
        "ADMIN_TOTP_SECRET must be base32 and decode to at least 16 bytes",
      );
    } else {
      totpSecret = totpRaw.replace(/\s+/g, "").toUpperCase();
    }
  } else if (mode === "full") {
    problems.push("ADMIN_TOTP_SECRET is required in full mode");
  }

  const tailscaleModeValue = env.ADMIN_TAILSCALE_MODE ?? "daemon";
  const tailscaleMode: AdminTailscaleMode =
    tailscaleModeValue === "local-dev" ? "local-dev" : "daemon";
  if (tailscaleModeValue !== "daemon" && tailscaleModeValue !== "local-dev") {
    problems.push('ADMIN_TAILSCALE_MODE must be "daemon" or "local-dev"');
  }
  let localDevLogin: string | undefined;
  if (tailscaleMode === "local-dev") {
    if (environment !== "development") {
      problems.push("ADMIN_TAILSCALE_MODE=local-dev is only allowed in development");
    }
    if (
      env.RAILWAY_ENVIRONMENT ||
      env.RAILWAY_PROJECT_ID ||
      env.RAILWAY_SERVICE_ID ||
      env.NODE_ENV === "production"
    ) {
      problems.push(
        "ADMIN_TAILSCALE_MODE=local-dev is refused on Railway or under NODE_ENV=production",
      );
    }
    localDevLogin = env.ADMIN_LOCAL_DEV_LOGIN?.trim();
    if (!localDevLogin || !operatorLogins.includes(localDevLogin)) {
      problems.push(
        "ADMIN_LOCAL_DEV_LOGIN must be one of ADMIN_OPERATOR_LOGINS in local-dev mode",
      );
    }
  }

  const hostname = (
    env.ADMIN_TS_HOSTNAME ?? `letter-irl-admin-${shortEnvironment}`
  ).toLowerCase();
  if (!HOSTNAME_PATTERN.test(hostname) || !hostname.endsWith(`-${shortEnvironment}`)) {
    problems.push(
      `ADMIN_TS_HOSTNAME must be a DNS label ending in -${shortEnvironment}`,
    );
  }
  const tag = env.ADMIN_TS_TAG ?? `tag:${shortEnvironment}-admin`;
  if (tag !== `tag:${shortEnvironment}-admin`) {
    problems.push(`ADMIN_TS_TAG must be tag:${shortEnvironment}-admin`);
  }
  const stateDir = env.ADMIN_TS_STATE_DIR ?? "/data/tailscale";
  if (!stateDir.startsWith("/") || stateDir.includes("..")) {
    problems.push("ADMIN_TS_STATE_DIR must be an absolute path");
  }
  const authKey = env.TS_AUTHKEY?.trim() || undefined;
  if (authKey && !authKey.startsWith("tskey-")) {
    problems.push("TS_AUTHKEY does not look like a Tailscale auth key");
  }

  const appPort = parsePort(env.ADMIN_APP_PORT, 8790, problems, "ADMIN_APP_PORT");
  const healthPort = parsePort(env.PORT, 8080, problems, "PORT");
  if (appPort === healthPort) {
    problems.push("ADMIN_APP_PORT and PORT must differ");
  }

  const stripeKey = env.STRIPE_SECRET_KEY ?? "";
  const stripeKeyMode: AdminRuntimeConfig["stripeKeyMode"] = !stripeKey
    ? "absent"
    : /^(sk|rk)_live_/.test(stripeKey)
      ? "live"
      : "test";
  const stripeKeyRestricted = stripeKey.startsWith("rk_");
  if (stripeKey && !/^(sk|rk)_(live|test)_/.test(stripeKey)) {
    problems.push("STRIPE_SECRET_KEY does not look like a Stripe secret key");
  }
  if (environment === "production" && stripeKeyMode === "test") {
    problems.push("STRIPE_SECRET_KEY must be a live key in production");
  }
  if (environment === "development" && stripeKeyMode === "live") {
    problems.push("STRIPE_SECRET_KEY must not be a live key in development");
  }

  if (problems.length > 0) {
    throw new AdminConfigurationError(problems);
  }

  const minute = 60_000;
  return {
    environment,
    shortEnvironment,
    mode,
    operatorLogins,
    tailscale: {
      mode: tailscaleMode,
      hostname,
      tag,
      stateDir,
      stateFile: `${stateDir}/tailscaled.state`,
      socketPath: `${stateDir}/tailscaled.sock`,
      authKey,
      localDevLogin,
    },
    appPort,
    healthPort,
    sessionSecret,
    totpSecret,
    readerDatabaseUrl: env.ADMIN_READER_DATABASE_URL as string,
    readerRole,
    operatorDatabaseUrl: mode === "full" ? (env.DATABASE_URL as string) : null,
    operatorRole,
    databaseHostname: reader?.hostname ?? "",
    databaseName: reader?.database ?? "",
    stripeKeyMode,
    stripeKeyRestricted,
    letterProvider: env.LETTER_PROVIDER ?? "unset",
    buildCommit: env.RAILWAY_GIT_COMMIT_SHA ?? "unknown",
    buildBranch: env.RAILWAY_GIT_BRANCH ?? "unknown",
    session: {
      idleTtlMs: 15 * minute,
      absoluteTtlMs: 8 * 60 * minute,
      elevationTtlMs:
        environment === "production" ? 10 * minute : 60 * minute,
      elevationMaxFailures: 5,
      elevationFailureWindowMs: 15 * minute,
    },
    packRefundCommandEnabled:
      env.LETTER_IRL_PACK_REFUND_COMMAND_ENABLED === "true",
  };
}

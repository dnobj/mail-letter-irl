import { describe, expect, it } from "vitest";

import { AdminConfigurationError } from "../../../src/admin/errors.js";
import { base32Length, parseAdminRuntimeConfig } from "../../../src/admin/runtimeConfig.js";

const READER = "postgres://letter_irl_admin_reader_development:pw@db.example.test/letter_irl_dev";
const OPERATOR = "postgres://letter_irl_admin_operator_development:pw@db.example.test/letter_irl_dev";

export const validDevelopmentEnv: NodeJS.ProcessEnv = {
  LETTER_IRL_DEPLOYMENT_ENVIRONMENT: "development",
  ADMIN_MODE: "read-only",
  ADMIN_OPERATOR_LOGINS: "owner@example.com, second@github",
  ADMIN_READER_DATABASE_URL: READER,
  DATABASE_URL: READER,
  ADMIN_SESSION_SECRET: "s".repeat(40),
  PORT: "8080",
  ADMIN_APP_PORT: "8790",
  STRIPE_SECRET_KEY: "rk_test_placeholder",
  LETTER_PROVIDER: "dummy",
};

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    parseAdminRuntimeConfig(env);
    return [];
  } catch (error) {
    if (error instanceof AdminConfigurationError) return [...error.problems];
    throw error;
  }
}

describe("admin runtime configuration", () => {
  it("derives every environment-specific name from the deployment identity", () => {
    const config = parseAdminRuntimeConfig(validDevelopmentEnv);
    expect(config.environment).toBe("development");
    expect(config.shortEnvironment).toBe("dev");
    expect(config.tailscale.hostname).toBe("letter-irl-admin-dev");
    expect(config.tailscale.tag).toBe("tag:dev-admin");
    expect(config.tailscale.stateFile).toBe("/data/tailscale/tailscaled.state");
    expect(config.tailscale.socketPath).toBe("/data/tailscale/tailscaled.sock");
    expect(config.readerRole).toBe("letter_irl_admin_reader_development");
    expect(config.operatorRole).toBe("letter_irl_admin_operator_development");
    expect(config.operatorDatabaseUrl).toBeNull();
    expect(config.operatorLogins).toEqual(["owner@example.com", "second@github"]);
    expect(config.stripeKeyMode).toBe("test");
    expect(config.stripeKeyRestricted).toBe(true);
    expect(config.session.elevationTtlMs).toBe(60 * 60_000);
    expect(config.totpSecret).toBeNull();
  });

  it("names the offending variables and never their values", () => {
    const problems = problemsOf({
      ...validDevelopmentEnv,
      ADMIN_OPERATOR_LOGINS: "not a login",
      ADMIN_SESSION_SECRET: "short",
      DATABASE_URL: OPERATOR,
      PORT: "8790",
      ADMIN_TS_TAG: "tag:prod-admin",
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ADMIN_OPERATOR_LOGINS"),
        expect.stringContaining("ADMIN_SESSION_SECRET"),
        expect.stringContaining("DATABASE_URL must connect as letter_irl_admin_reader_development"),
        expect.stringContaining("ADMIN_APP_PORT and PORT must differ"),
        expect.stringContaining("ADMIN_TS_TAG must be tag:dev-admin"),
      ]),
    );
    expect(problems.join("\n")).not.toContain("pw@");
    expect(problems.join("\n")).not.toContain("short");
  });

  it("requires the operator role, a TOTP secret and matching hosts in full mode", () => {
    expect(problemsOf({ ...validDevelopmentEnv, ADMIN_MODE: "full", DATABASE_URL: READER })).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DATABASE_URL must connect as letter_irl_admin_operator_development in full mode"),
        expect.stringContaining("ADMIN_TOTP_SECRET is required in full mode"),
      ]),
    );
    const config = parseAdminRuntimeConfig({
      ...validDevelopmentEnv,
      ADMIN_MODE: "full",
      DATABASE_URL: OPERATOR,
      ADMIN_TOTP_SECRET: "jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp",
    });
    expect(config.mode).toBe("full");
    expect(config.operatorDatabaseUrl).toBe(OPERATOR);
    expect(config.totpSecret).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(
      problemsOf({
        ...validDevelopmentEnv,
        ADMIN_MODE: "full",
        ADMIN_TOTP_SECRET: "JBSWY3DP",
        DATABASE_URL: OPERATOR.replace("db.example.test", "other.example.test"),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ADMIN_TOTP_SECRET must be base32"),
        expect.stringContaining("must name the same host"),
      ]),
    );
  });

  it("refuses production without NODE_ENV=production and with a test Stripe key", () => {
    const production = {
      ...validDevelopmentEnv,
      LETTER_IRL_DEPLOYMENT_ENVIRONMENT: "production",
      ADMIN_READER_DATABASE_URL: READER.replace("development", "production"),
      DATABASE_URL: READER.replace("development", "production"),
    };
    expect(problemsOf(production)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("requires NODE_ENV=production"),
        expect.stringContaining("STRIPE_SECRET_KEY must be a live key in production"),
      ]),
    );
    const config = parseAdminRuntimeConfig({
      ...production,
      NODE_ENV: "production",
      STRIPE_SECRET_KEY: "rk_live_placeholder",
    });
    expect(config.tailscale.tag).toBe("tag:prod-admin");
    expect(config.tailscale.hostname).toBe("letter-irl-admin-prod");
    expect(config.session.elevationTtlMs).toBe(10 * 60_000);
    expect(problemsOf({ ...validDevelopmentEnv, STRIPE_SECRET_KEY: "sk_live_placeholder" })).toEqual(
      expect.arrayContaining([
        "STRIPE_SECRET_KEY must not be a live key in development",
        expect.stringContaining("must be a restricted key"),
      ]),
    );
  });

  it("refuses a full secret key on the admin service, in either environment", () => {
    // The guide has always said to use a restricted key here, because the
    // panel reads Stripe and issues refunds. The service now refuses to boot
    // without one rather than trusting the runbook.
    expect(problemsOf({ ...validDevelopmentEnv, STRIPE_SECRET_KEY: "sk_test_placeholder" })).toEqual([
      "STRIPE_SECRET_KEY on the admin service must be a restricted key (rk_), not a full secret key",
    ]);
    expect(problemsOf({ ...validDevelopmentEnv, STRIPE_SECRET_KEY: "rk_test_placeholder" })).toEqual([]);
    // Absent stays allowed: the Stripe page reports the key as absent and the
    // commands that need it are disabled.
    const { STRIPE_SECRET_KEY: _omitted, ...withoutKey } = validDevelopmentEnv;
    expect(problemsOf(withoutKey)).toEqual([]);
  });

  it("classifies a malformed key as absent rather than as a test key", () => {
    // Anything without a recognised prefix used to fall through to "test",
    // which would have let a production service boot on a typo.
    const problems = problemsOf({ ...validDevelopmentEnv, STRIPE_SECRET_KEY: "not-a-key" });
    expect(problems).toEqual(["STRIPE_SECRET_KEY does not look like a Stripe secret key"]);
  });

  it("allows local-dev mode only off Railway, in development, with an allowlisted login", () => {
    expect(
      problemsOf({ ...validDevelopmentEnv, ADMIN_TAILSCALE_MODE: "local-dev", ADMIN_LOCAL_DEV_LOGIN: "owner@example.com" }),
    ).toEqual([]);
    expect(
      problemsOf({
        ...validDevelopmentEnv,
        ADMIN_TAILSCALE_MODE: "local-dev",
        ADMIN_LOCAL_DEV_LOGIN: "owner@example.com",
        RAILWAY_ENVIRONMENT: "development",
      }),
    ).toEqual([expect.stringContaining("refused on Railway")]);
    expect(
      problemsOf({ ...validDevelopmentEnv, ADMIN_TAILSCALE_MODE: "local-dev", ADMIN_LOCAL_DEV_LOGIN: "stranger@example.com" }),
    ).toEqual([expect.stringContaining("ADMIN_LOCAL_DEV_LOGIN must be one of ADMIN_OPERATOR_LOGINS")]);
  });

  it("validates the auth key shape and base32 lengths", () => {
    expect(problemsOf({ ...validDevelopmentEnv, TS_AUTHKEY: "nope" })).toEqual([
      expect.stringContaining("TS_AUTHKEY"),
    ]);
    expect(parseAdminRuntimeConfig({ ...validDevelopmentEnv, TS_AUTHKEY: "tskey-auth-abc" }).tailscale.authKey).toBe(
      "tskey-auth-abc",
    );
    expect(base32Length("JBSWY3DPEHPK3PXP")).toBe(10);
    expect(base32Length("not base32!")).toBe(-1);
  });
});

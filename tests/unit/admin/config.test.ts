import { describe, expect, it } from "vitest";

import {
  parseAdminEnvironmentConfig,
  parseAdminLaunchArguments,
  validateAdminCredentialEnvironment,
  validateAdminDatabaseIdentity,
  validateAdminLaunchPolicy,
  validatePublicServerAdminConfiguration,
} from "../../../src/admin/config.js";
import { AdminFoundationError } from "../../../src/admin/errors.js";
import { validDevelopmentAdminConfig } from "../../fixtures/admin.js";

function expectAdminCode(action: () => unknown, code: string) {
  expect(action).toThrowError(
    expect.objectContaining<Partial<AdminFoundationError>>({ code }),
  );
}

describe("admin environment configuration", () => {
  it("parses strict environment-specific configuration", () => {
    const config = parseAdminEnvironmentConfig(validDevelopmentAdminConfig);

    expect(config.environment).toBe("development");
    expect(config.database.readerRole).toBe(
      "letter_irl_admin_reader_development",
    );
  });

  it("rejects unknown fields and copied production roles", () => {
    expectAdminCode(
      () =>
        parseAdminEnvironmentConfig({
          ...validDevelopmentAdminConfig,
          unexpected: true,
        }),
      "ADMIN_INVALID_CONFIGURATION",
    );
    expectAdminCode(
      () =>
        parseAdminEnvironmentConfig({
          ...validDevelopmentAdminConfig,
          database: {
            ...validDevelopmentAdminConfig.database,
            readerRole: "letter_irl_admin_reader_production",
          },
        }),
      "ADMIN_INVALID_CONFIGURATION",
    );
    expectAdminCode(
      () =>
        parseAdminEnvironmentConfig({
          ...validDevelopmentAdminConfig,
          credentials: {
            readerSecretName: "LetterIRL-Copied-Secret",
            operatorSecretName: "LetterIRL-Copied-Secret",
          },
        }),
      "ADMIN_INVALID_CONFIGURATION",
    );
  });

  it("rejects generic production database environment values", () => {
    expectAdminCode(
      () =>
        validateAdminCredentialEnvironment("production", {
          DATABASE_URL: "postgresql://redacted.invalid/production",
        }),
      "ADMIN_INVALID_CONFIGURATION",
    );

    expect(() =>
      validateAdminCredentialEnvironment("development", {
        DATABASE_URL: "postgresql://redacted.invalid/development",
      }),
    ).not.toThrow();
  });

  it("fails public server startup when a legacy admin flag tries to enable routes", () => {
    expectAdminCode(
      () => validatePublicServerAdminConfiguration({ ADMIN_ENABLED: "true" }),
      "ADMIN_LEGACY_ROUTES_DISABLED",
    );
    expect(() =>
      validatePublicServerAdminConfiguration({ ADMIN_ENABLED: "false" }),
    ).not.toThrow();
  });

  it("parses only explicit non-secret launch arguments", () => {
    expect(
      parseAdminLaunchArguments([
        "--environment",
        "development",
        "--config",
        "development.json",
      ]),
    ).toEqual({
      environment: "development",
      mode: "read-only",
      configPath: "development.json",
      port: undefined,
    });

    expectAdminCode(
      () =>
        parseAdminLaunchArguments([
          "--environment",
          "development",
          "--config",
          "development.json",
          "--database-url",
          "postgresql://secret.invalid/database",
        ]),
      "ADMIN_INVALID_CONFIGURATION",
    );
  });

  it("fails closed on launch environment and port mismatch", () => {
    const config = parseAdminEnvironmentConfig(validDevelopmentAdminConfig);
    expectAdminCode(
      () =>
        validateAdminLaunchPolicy(config, {
          environment: "production",
          mode: "read-only",
        }),
      "ADMIN_ENVIRONMENT_MISMATCH",
    );
    expectAdminCode(
      () =>
        validateAdminLaunchPolicy(config, {
          environment: "development",
          mode: "read-only",
          port: 8788,
        }),
      "ADMIN_INVALID_CONFIGURATION",
    );
  });
});

describe("admin database identity validation", () => {
  const config = parseAdminEnvironmentConfig(validDevelopmentAdminConfig);
  const connectionString =
    "postgresql://letter_irl_admin_reader_development:never-log@dev-db.example.test/letter_irl_dev";
  const identity = {
    databaseName: "letter_irl_dev",
    roleName: "letter_irl_admin_reader_development",
    marker: "development",
  } as const;

  it("accepts a matching host, name, role, marker, and mode", () => {
    expect(() =>
      validateAdminDatabaseIdentity(
        config,
        "read-only",
        connectionString,
        identity,
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "ADMIN_DATABASE_HOST_MISMATCH",
      "postgresql://letter_irl_admin_reader_development:x@prod-db.example.test/letter_irl_dev",
      identity,
    ],
    [
      "ADMIN_DATABASE_NAME_MISMATCH",
      "postgresql://letter_irl_admin_reader_development:x@dev-db.example.test/letter_irl_prod",
      identity,
    ],
    [
      "ADMIN_DATABASE_ROLE_MISMATCH",
      connectionString,
      { ...identity, roleName: "letter_irl_admin_operator_development" },
    ],
    [
      "ADMIN_DATABASE_MARKER_MISSING",
      connectionString,
      { ...identity, marker: null },
    ],
    [
      "ADMIN_ENVIRONMENT_MISMATCH",
      connectionString,
      { ...identity, marker: "production" },
    ],
  ])("fails closed with stable code %s", (code, url, candidateIdentity) => {
    expectAdminCode(
      () =>
        validateAdminDatabaseIdentity(
          config,
          "read-only",
          url,
          candidateIdentity,
        ),
      code,
    );
  });
});

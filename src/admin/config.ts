import { readFile } from "node:fs/promises";

import { z } from "zod";

import { AdminEnvironmentSchema, AdminModeSchema } from "./contracts.js";
import { AdminFoundationError } from "./errors.js";

const WindowsSidSchema = z
  .string()
  .regex(/^S-\d(?:-\d+)+$/)
  .max(255);
const DatabaseRoleSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const DatabaseNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,63}$/);
const HostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

export const AdminEnvironmentConfigSchema = z
  .object({
    version: z.literal(1),
    environment: AdminEnvironmentSchema,
    displayName: z.string().trim().min(1).max(80),
    database: z
      .object({
        hostname: HostnameSchema,
        name: DatabaseNameSchema,
        marker: AdminEnvironmentSchema,
        readerRole: DatabaseRoleSchema,
        operatorRole: DatabaseRoleSchema,
      })
      .strict(),
    allowedOperatorSids: z.array(WindowsSidSchema).min(1).max(20),
    credentials: z
      .object({
        readerSecretName: z.string().trim().min(1).max(255),
        operatorSecretName: z.string().trim().min(1).max(255),
      })
      .strict(),
    integrations: z
      .object({
        stripeMode: z.enum(["test", "live"]),
        postGridMode: z.enum(["dummy", "test", "live"]),
      })
      .strict(),
    allowedModes: z.array(AdminModeSchema).min(1).max(2),
    session: z
      .object({
        bootstrapTtlSeconds: z.number().int().min(15).max(60),
        idleTtlMinutes: z.number().int().min(1).max(15),
        absoluteTtlMinutes: z.number().int().min(5).max(60),
        elevationTtlMinutes: z.number().int().min(1).max(10),
      })
      .strict(),
    network: z
      .object({
        portMin: z.number().int().min(49152).max(65535),
        portMax: z.number().int().min(49152).max(65535),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const suffix = config.environment;
    if (config.database.marker !== config.environment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["database", "marker"],
        message: "Database marker must match the configured environment",
      });
    }
    if (config.database.readerRole !== `letter_irl_admin_reader_${suffix}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["database", "readerRole"],
        message: "Reader role must be environment-specific",
      });
    }
    if (
      config.database.operatorRole !== `letter_irl_admin_operator_${suffix}`
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["database", "operatorRole"],
        message: "Operator role must be environment-specific",
      });
    }
    if (!config.allowedModes.includes("read-only")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedModes"],
        message: "Read-only mode must always be allowed",
      });
    }
    if (new Set(config.allowedModes).size !== config.allowedModes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedModes"],
        message: "Allowed modes must be unique",
      });
    }
    if (
      config.credentials.readerSecretName ===
      config.credentials.operatorSecretName
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials"],
        message:
          "Reader and operator credentials must use different secret names",
      });
    }
    if (config.network.portMin > config.network.portMax) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message: "Port minimum cannot exceed port maximum",
      });
    }
    if (config.session.idleTtlMinutes >= config.session.absoluteTtlMinutes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session"],
        message: "Idle expiry must be shorter than absolute expiry",
      });
    }
    if (config.environment === "development") {
      if (
        config.integrations.stripeMode !== "test" ||
        config.integrations.postGridMode === "live"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["integrations"],
          message: "Development configuration cannot expect live integrations",
        });
      }
    } else if (
      config.integrations.stripeMode !== "live" ||
      config.integrations.postGridMode !== "live"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["integrations"],
        message: "Production configuration must expect live integrations",
      });
    }
  });

export type AdminEnvironmentConfig = z.output<
  typeof AdminEnvironmentConfigSchema
>;

export const AdminDatabaseIdentitySchema = z
  .object({
    databaseName: DatabaseNameSchema,
    roleName: DatabaseRoleSchema,
    marker: AdminEnvironmentSchema.nullable(),
  })
  .strict();

export interface AdminLaunchArguments {
  environment: "development" | "production";
  mode: "read-only" | "full";
  configPath: string;
  port?: number;
}

function invalidConfiguration(cause?: unknown): AdminFoundationError {
  void cause;
  return new AdminFoundationError("ADMIN_INVALID_CONFIGURATION");
}

export function parseAdminEnvironmentConfig(
  input: unknown,
): AdminEnvironmentConfig {
  const parsed = AdminEnvironmentConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidConfiguration(parsed.error);
  }
  return parsed.data;
}

export async function loadAdminEnvironmentConfig(
  configPath: string,
): Promise<AdminEnvironmentConfig> {
  try {
    const content = await readFile(configPath, "utf8");
    return parseAdminEnvironmentConfig(JSON.parse(content));
  } catch (error) {
    if (error instanceof AdminFoundationError) {
      throw error;
    }
    throw invalidConfiguration(error);
  }
}

function readArgumentValue(arguments_: string[], index: number): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw invalidConfiguration();
  }
  return value;
}

export function parseAdminLaunchArguments(
  arguments_: string[],
): AdminLaunchArguments {
  let environment: AdminLaunchArguments["environment"] | undefined;
  let mode: AdminLaunchArguments["mode"] = "read-only";
  let configPath: string | undefined;
  let port: number | undefined;

  try {
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index];
      if (
        argument === "--database-url" ||
        argument.startsWith("--database-url=")
      ) {
        throw invalidConfiguration();
      }
      if (argument === "--environment") {
        environment = AdminEnvironmentSchema.parse(
          readArgumentValue(arguments_, index),
        );
        index += 1;
        continue;
      }
      if (argument === "--mode") {
        mode = AdminModeSchema.parse(readArgumentValue(arguments_, index));
        index += 1;
        continue;
      }
      if (argument === "--config") {
        configPath = readArgumentValue(arguments_, index);
        index += 1;
        continue;
      }
      if (argument === "--port") {
        const rawPort = readArgumentValue(arguments_, index);
        port = z.coerce.number().int().min(49152).max(65535).parse(rawPort);
        index += 1;
        continue;
      }
      throw invalidConfiguration();
    }
  } catch (error) {
    if (error instanceof AdminFoundationError) {
      throw error;
    }
    throw invalidConfiguration(error);
  }

  if (!environment || !configPath) {
    throw invalidConfiguration();
  }

  return { environment, mode, configPath, port };
}

export function validateAdminLaunchPolicy(
  config: AdminEnvironmentConfig,
  launch: Pick<AdminLaunchArguments, "environment" | "mode" | "port">,
): void {
  if (launch.environment !== config.environment) {
    throw new AdminFoundationError("ADMIN_ENVIRONMENT_MISMATCH");
  }
  if (!config.allowedModes.includes(launch.mode)) {
    throw invalidConfiguration();
  }
  if (
    launch.port !== undefined &&
    (launch.port < config.network.portMin ||
      launch.port > config.network.portMax)
  ) {
    throw invalidConfiguration();
  }
}

export function validateAdminCredentialEnvironment(
  environment: "development" | "production",
  processEnvironment: NodeJS.ProcessEnv,
): void {
  if (environment === "production" && processEnvironment.DATABASE_URL) {
    throw invalidConfiguration();
  }
}

export function validatePublicServerAdminConfiguration(
  processEnvironment: NodeJS.ProcessEnv,
): void {
  if (processEnvironment.ADMIN_ENABLED === "true") {
    throw new AdminFoundationError("ADMIN_LEGACY_ROUTES_DISABLED");
  }
}

/**
 * Names the feature flags that must stay disabled while the legacy public admin
 * surface is denied.
 *
 * Issue #69's ambiguous-image operator recovery routes live under
 * `/api/admin/image-generation/*`, which this slice answers with a no-store 404.
 * Enabling JIT purchase or the image trial without an operator recovery path
 * would strand quota that only an operator decision can resolve.
 *
 * This deliberately warns instead of throwing. A hard failure here would turn a
 * flag combination into a boot loop on an already-running deployment, which is a
 * worse outcome than the condition it reports.
 */
export const ADMIN_COUPLED_FEATURE_FLAGS = [
  "JIT_PURCHASE_ENABLED",
  "IMAGE_TRIAL_ENABLED",
] as const;

export function findCoupledFeatureFlagWarnings(
  processEnvironment: NodeJS.ProcessEnv,
): string[] {
  return ADMIN_COUPLED_FEATURE_FLAGS.filter(
    (flag) => processEnvironment[flag] === "true",
  );
}

function parseConnectionUrl(connectionString: string): URL {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw invalidConfiguration();
    }
    return url;
  } catch {
    throw invalidConfiguration();
  }
}

export function validateAdminDatabaseIdentity(
  config: AdminEnvironmentConfig,
  mode: "read-only" | "full",
  connectionString: string,
  identityInput: unknown,
): void {
  const identityResult = AdminDatabaseIdentitySchema.safeParse(identityInput);
  if (!identityResult.success) {
    throw invalidConfiguration(identityResult.error);
  }

  const connectionUrl = parseConnectionUrl(connectionString);
  const identity = identityResult.data;
  const expectedRole =
    mode === "read-only"
      ? config.database.readerRole
      : config.database.operatorRole;
  const urlDatabaseName = decodeURIComponent(
    connectionUrl.pathname.replace(/^\//, ""),
  );
  const urlRoleName = decodeURIComponent(connectionUrl.username);

  if (connectionUrl.hostname.toLowerCase() !== config.database.hostname) {
    throw new AdminFoundationError("ADMIN_DATABASE_HOST_MISMATCH");
  }
  if (
    urlDatabaseName !== config.database.name ||
    identity.databaseName !== config.database.name
  ) {
    throw new AdminFoundationError("ADMIN_DATABASE_NAME_MISMATCH");
  }
  if (urlRoleName !== expectedRole || identity.roleName !== expectedRole) {
    throw new AdminFoundationError("ADMIN_DATABASE_ROLE_MISMATCH");
  }
  if (identity.marker === null) {
    throw new AdminFoundationError("ADMIN_DATABASE_MARKER_MISSING");
  }
  if (identity.marker !== config.database.marker) {
    throw new AdminFoundationError("ADMIN_ENVIRONMENT_MISMATCH");
  }
}

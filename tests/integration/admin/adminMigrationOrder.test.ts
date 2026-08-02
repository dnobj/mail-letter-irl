import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../../../src/cli/migrate.js";

const databaseUrl = process.env.LETTER_IRL_ADMIN_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

const JIT_FOUNDATION_MIGRATION = "021_jit_commerce_foundation.sql";
const ADMIN_AUDIT_MIGRATION = "022_admin_audit.sql";
const JIT_RECOVERY_MIGRATION = "023_jit_recovery_state_machines.sql";

const ADMIN_RELATIONS = [
  "admin_environment_marker",
  "admin_audit_events",
  "admin_command_runs",
  "admin_operations",
];

interface Fingerprint {
  ledger: string[];
  columns: string[];
  constraints: string[];
  indexes: string[];
  triggers: string[];
  routines: string[];
  privileges: string[];
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]+$/.test(identifier)) {
    throw new Error("Unsafe test schema identifier");
  }
  return `"${identifier}"`;
}

function scenarioSchemaName(slug: string): string {
  return `admin_order_${slug}_${randomUUID().replace(/-/g, "")}`;
}

function scenarioConnectionString(schemaName: string): string {
  const url = new URL(databaseUrl as string);
  url.searchParams.set("options", `-c search_path=${schemaName}`);
  return url.toString();
}

/**
 * Replaces the generated schema name so fingerprints from different scenario
 * schemas compare on structure alone.
 */
function normalize(schemaName: string, value: string | null): string {
  if (value === null) return "";
  return value.split(schemaName).join("<schema>");
}

async function readFingerprint(
  client: PoolClient,
  schemaName: string,
): Promise<Fingerprint> {
  const ledger = await client.query<{ name: string }>(
    "SELECT name FROM migrations ORDER BY id",
  );

  const columns = await client.query<{ entry: string }>(
    `
      SELECT format(
        '%s.%s ordinal=%s type=%s nullable=%s default=%s identity=%s generated=%s collation=%s',
        table_name, column_name, ordinal_position,
        format_type(attribute.atttypid, attribute.atttypmod),
        is_nullable, COALESCE(column_default, '-'),
        is_identity, is_generated, COALESCE(collation_name, '-')
      ) AS entry
      FROM information_schema.columns AS meta
      JOIN pg_namespace AS namespace ON namespace.nspname = meta.table_schema
      JOIN pg_class AS relation
        ON relation.relnamespace = namespace.oid AND relation.relname = meta.table_name
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid AND attribute.attname = meta.column_name
      WHERE meta.table_schema = $1
      ORDER BY entry
    `,
    [schemaName],
  );

  const constraints = await client.query<{ entry: string }>(
    `
      SELECT format(
        '%s.%s %s deferrable=%s validated=%s',
        relation.relname, constraint_definition.conname,
        pg_get_constraintdef(constraint_definition.oid),
        constraint_definition.condeferrable, constraint_definition.convalidated
      ) AS entry
      FROM pg_constraint AS constraint_definition
      JOIN pg_class AS relation ON relation.oid = constraint_definition.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
      ORDER BY entry
    `,
    [schemaName],
  );

  const indexes = await client.query<{ entry: string }>(
    "SELECT indexdef AS entry FROM pg_indexes WHERE schemaname = $1 ORDER BY entry",
    [schemaName],
  );

  const triggers = await client.query<{ entry: string }>(
    `
      SELECT pg_get_triggerdef(trigger_definition.oid) AS entry
      FROM pg_trigger AS trigger_definition
      JOIN pg_class AS relation ON relation.oid = trigger_definition.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND NOT trigger_definition.tgisinternal
      ORDER BY entry
    `,
    [schemaName],
  );

  const routines = await client.query<{ entry: string }>(
    `
      SELECT pg_get_functiondef(routine.oid) AS entry
      FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = $1
      ORDER BY entry
    `,
    [schemaName],
  );

  const privileges = await client.query<{ entry: string }>(
    `
      SELECT format(
        '%s grantee=%s privilege=%s grantable=%s',
        relation.relname,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
             ELSE COALESCE(pg_get_userbyid(privilege.grantee), 'unknown') END,
        privilege.privilege_type, privilege.is_grantable
      ) AS entry
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r', relation.relowner))
      ) AS privilege
      WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
      ORDER BY entry
    `,
    [schemaName],
  );

  const project = (rows: { entry: string }[]): string[] =>
    rows.map((row) => normalize(schemaName, row.entry)).sort();

  return {
    ledger: ledger.rows.map((row) => row.name),
    columns: project(columns.rows),
    constraints: project(constraints.rows),
    indexes: project(indexes.rows),
    triggers: project(triggers.rows),
    routines: project(routines.rows),
    privileges: project(privileges.rows),
  };
}

function selectAdminObjects(fingerprint: Fingerprint): Fingerprint {
  const ownedBy022 = (entry: string): boolean =>
    ADMIN_RELATIONS.some((relation) => entry.includes(relation)) ||
    entry.includes("reject_admin_audit_event_mutation");

  return {
    ledger: fingerprint.ledger.filter((name) => name === ADMIN_AUDIT_MIGRATION),
    columns: fingerprint.columns.filter(ownedBy022),
    constraints: fingerprint.constraints.filter(ownedBy022),
    indexes: fingerprint.indexes.filter(ownedBy022),
    triggers: fingerprint.triggers.filter(ownedBy022),
    routines: fingerprint.routines.filter(ownedBy022),
    privileges: fingerprint.privileges.filter(ownedBy022),
  };
}

describeWithDatabase("admin migration arrival order compatibility", () => {
  const migrationsDirectory = join(process.cwd(), "db", "migrations");
  const createdSchemas: string[] = [];
  let stagingRoot: string;
  let adminPool: InstanceType<typeof Pool>;
  let adminClient: PoolClient;

  beforeAll(async () => {
    if (!databaseUrl) return;

    const parsedUrl = new URL(databaseUrl);
    if (
      !["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname) ||
      !decodeURIComponent(parsedUrl.pathname).toLowerCase().includes("test")
    ) {
      throw new Error(
        "Admin integration tests require a loopback database whose name contains test",
      );
    }

    const available = await readdir(migrationsDirectory);
    for (const required of [
      JIT_FOUNDATION_MIGRATION,
      ADMIN_AUDIT_MIGRATION,
      JIT_RECOVERY_MIGRATION,
    ]) {
      if (!available.includes(required)) {
        throw new Error(
          `Arrival-order proof requires the real ${required} in db/migrations`,
        );
      }
    }

    stagingRoot = await mkdtemp(join(tmpdir(), "letter-irl-migration-order-"));
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    adminClient = await adminPool.connect();
  }, 60_000);

  afterAll(async () => {
    if (adminClient) {
      for (const schemaName of createdSchemas) {
        await adminClient.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
        );
      }
      adminClient.release();
      await adminPool.end();
    }
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });

  /**
   * Copies the real repository migrations whose filenames pass `accept` into a
   * disposable directory so the real migrator observes a specific arrival.
   */
  async function stage(slug: string, accept: (file: string) => boolean) {
    const directory = join(stagingRoot, `${slug}-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const files = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .filter(accept);
    for (const file of files) {
      await copyFile(join(migrationsDirectory, file), join(directory, file));
    }
    return directory;
  }

  async function runScenario(
    slug: string,
    stages: ((file: string) => boolean)[],
  ): Promise<Fingerprint> {
    const schemaName = scenarioSchemaName(slug);
    createdSchemas.push(schemaName);
    await adminClient.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);

    const connectionString = scenarioConnectionString(schemaName);
    for (const [index, accept] of stages.entries()) {
      const migrationsStage = await stage(`${slug}-${index}`, accept);
      await migrate({ connectionString, migrationsDirectory: migrationsStage });
    }

    const scenarioPool = new Pool({ connectionString, max: 1 });
    try {
      const scenarioClient = await scenarioPool.connect();
      try {
        return await readFingerprint(scenarioClient, schemaName);
      } finally {
        scenarioClient.release();
      }
    } finally {
      await scenarioPool.end();
    }
  }

  const upToJit = (file: string) => file <= JIT_FOUNDATION_MIGRATION;
  const notAdminAudit = (file: string) => file !== ADMIN_AUDIT_MIGRATION;
  const notJitRecovery = (file: string) => file !== JIT_RECOVERY_MIGRATION;
  const everything = () => true;

  let sliceOne: Fingerprint;
  let recoveryFirst: Fingerprint;
  let auditFirst: Fingerprint;

  it("applies 001-020 -> 021 -> 022 with the real migrator", async () => {
    sliceOne = await runScenario("slice_one", [notJitRecovery]);

    expect(sliceOne.ledger.slice(-2)).toEqual([
      JIT_FOUNDATION_MIGRATION,
      ADMIN_AUDIT_MIGRATION,
    ]);
    expect(sliceOne.ledger).not.toContain(JIT_RECOVERY_MIGRATION);
    for (const relation of ADMIN_RELATIONS) {
      expect(sliceOne.columns.some((entry) => entry.startsWith(`${relation}.`))).toBe(
        true,
      );
    }
  }, 180_000);

  it("applies 001-020 -> 021 -> 023 -> 022 when issue #69 lands first", async () => {
    recoveryFirst = await runScenario("recovery_first", [
      notAdminAudit,
      everything,
    ]);

    expect(recoveryFirst.ledger.slice(-3)).toEqual([
      JIT_FOUNDATION_MIGRATION,
      JIT_RECOVERY_MIGRATION,
      ADMIN_AUDIT_MIGRATION,
    ]);
  }, 180_000);

  it("applies 001-020 -> 021 -> 022 -> 023 when this branch lands first", async () => {
    auditFirst = await runScenario("audit_first", [notJitRecovery, everything]);

    expect(auditFirst.ledger.slice(-3)).toEqual([
      JIT_FOUNDATION_MIGRATION,
      ADMIN_AUDIT_MIGRATION,
      JIT_RECOVERY_MIGRATION,
    ]);
  }, 180_000);

  it("converges on identical structure regardless of 022/023 arrival order", () => {
    expect(recoveryFirst.columns).toEqual(auditFirst.columns);
    expect(recoveryFirst.constraints).toEqual(auditFirst.constraints);
    expect(recoveryFirst.indexes).toEqual(auditFirst.indexes);
    expect(recoveryFirst.triggers).toEqual(auditFirst.triggers);
    expect(recoveryFirst.routines).toEqual(auditFirst.routines);
    expect(recoveryFirst.privileges).toEqual(auditFirst.privileges);
    expect([...recoveryFirst.ledger].sort()).toEqual(
      [...auditFirst.ledger].sort(),
    );
  });

  it("keeps migration 022 objects identical in every proven order", () => {
    const sliceOneAdmin = selectAdminObjects(sliceOne);
    const recoveryFirstAdmin = selectAdminObjects(recoveryFirst);
    const auditFirstAdmin = selectAdminObjects(auditFirst);

    expect(sliceOneAdmin.columns.length).toBeGreaterThan(0);
    expect(sliceOneAdmin.constraints.length).toBeGreaterThan(0);
    expect(sliceOneAdmin.triggers.length).toBeGreaterThan(0);

    expect(recoveryFirstAdmin).toEqual(sliceOneAdmin);
    expect(auditFirstAdmin).toEqual(sliceOneAdmin);
  });

  it("refuses migration 022 when the JIT foundation 021 is absent", async () => {
    const schemaName = scenarioSchemaName("missing_021");
    createdSchemas.push(schemaName);
    await adminClient.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);

    const connectionString = scenarioConnectionString(schemaName);
    const withoutJit = await stage(
      "missing_021",
      (file) => file !== JIT_FOUNDATION_MIGRATION && file !== JIT_RECOVERY_MIGRATION,
    );

    await expect(
      migrate({ connectionString, migrationsDirectory: withoutJit }),
    ).rejects.toMatchObject({ code: "55000" });

    const scenarioPool = new Pool({ connectionString, max: 1 });
    try {
      const applied = await scenarioPool.query<{ name: string }>(
        "SELECT name FROM migrations ORDER BY id",
      );
      expect(applied.rows.map((row) => row.name)).not.toContain(
        ADMIN_AUDIT_MIGRATION,
      );
    } finally {
      await scenarioPool.end();
    }
  }, 180_000);

  it("proves the staged 022 is the real repository file", async () => {
    const staged = await stage("identity", upToJit);
    const files = await readdir(staged);
    expect(files).toContain(JIT_FOUNDATION_MIGRATION);
    expect(files).not.toContain(ADMIN_AUDIT_MIGRATION);

    const full = await stage("identity_full", everything);
    const fullFiles = await readdir(full);
    expect(fullFiles).toContain(ADMIN_AUDIT_MIGRATION);
    expect(fullFiles).toContain(JIT_RECOVERY_MIGRATION);
  });
});

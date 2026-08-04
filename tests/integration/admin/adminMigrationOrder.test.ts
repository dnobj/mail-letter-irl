import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  comments: string[];
  routinePrivileges: string[];
  schemaPrivileges: string[];
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

  // Migration 022 documents every table and its audit trigger function with
  // COMMENT ON. Without this leg the fingerprint cannot see a lost or reworded
  // comment, and cannot see one arrival order winning a COMMENT race.
  const comments = await client.query<{ entry: string }>(
    `
      SELECT format('relation %s = %s', relation.relname, description.description) AS entry
      FROM pg_description AS description
      JOIN pg_class AS relation ON relation.oid = description.objoid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1 AND description.objsubid = 0
      UNION ALL
      SELECT format('column %s.%s = %s', relation.relname, attribute.attname, description.description)
      FROM pg_description AS description
      JOIN pg_class AS relation ON relation.oid = description.objoid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid AND attribute.attnum = description.objsubid
      WHERE namespace.nspname = $1 AND description.objsubid > 0
      UNION ALL
      SELECT format('routine %s = %s', routine.proname, description.description)
      FROM pg_description AS description
      JOIN pg_proc AS routine ON routine.oid = description.objoid
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = $1
      ORDER BY 1
    `,
    [schemaName],
  );

  // The relation privilege query above filters relkind, so pg_proc ACLs are
  // invisible to it. A migration that revoked (or failed to revoke) EXECUTE on a
  // trigger function would not show up without this leg.
  const routinePrivileges = await client.query<{ entry: string }>(
    `
      SELECT format(
        '%s(%s) grantee=%s privilege=%s grantable=%s',
        routine.proname, pg_get_function_identity_arguments(routine.oid),
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
             ELSE COALESCE(pg_get_userbyid(privilege.grantee), 'unknown') END,
        privilege.privilege_type, privilege.is_grantable
      ) AS entry
      FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(routine.proacl, acldefault('f', routine.proowner))
      ) AS privilege
      WHERE namespace.nspname = $1
      ORDER BY entry
    `,
    [schemaName],
  );

  const schemaPrivileges = await client.query<{ entry: string }>(
    `
      SELECT format(
        'schema grantee=%s privilege=%s grantable=%s',
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
             ELSE COALESCE(pg_get_userbyid(privilege.grantee), 'unknown') END,
        privilege.privilege_type, privilege.is_grantable
      ) AS entry
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) AS privilege
      WHERE namespace.nspname = $1
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
    comments: project(comments.rows),
    routinePrivileges: project(routinePrivileges.rows),
    schemaPrivileges: project(schemaPrivileges.rows),
  };
}

type AdminObjects = Omit<Fingerprint, "ledger">;

function selectAdminObjects(fingerprint: Fingerprint): AdminObjects {
  const ownedBy022 = (entry: string): boolean =>
    ADMIN_RELATIONS.some((relation) => entry.includes(relation)) ||
    entry.includes("reject_admin_audit_event_mutation");

  // The ledger leg is deliberately absent. Filtering it to the single expected
  // migration name made it constant across every scenario, so comparing it
  // proved nothing. Ledger content is asserted per scenario instead.
  return {
    columns: fingerprint.columns.filter(ownedBy022),
    constraints: fingerprint.constraints.filter(ownedBy022),
    indexes: fingerprint.indexes.filter(ownedBy022),
    triggers: fingerprint.triggers.filter(ownedBy022),
    routines: fingerprint.routines.filter(ownedBy022),
    privileges: fingerprint.privileges.filter(ownedBy022),
    comments: fingerprint.comments.filter(ownedBy022),
    routinePrivileges: fingerprint.routinePrivileges.filter(ownedBy022),
    // Schema-level grants are not owned by any one relation, so they are
    // compared whole rather than filtered to 022's objects.
    schemaPrivileges: fingerprint.schemaPrivileges,
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
    // The two scenarios applied 022 and 023 in opposite orders, so this is a
    // real comparison rather than a schema compared against itself.
    expect(recoveryFirst.ledger).not.toEqual(auditFirst.ledger);

    expect(recoveryFirst.columns).toEqual(auditFirst.columns);
    expect(recoveryFirst.constraints).toEqual(auditFirst.constraints);
    expect(recoveryFirst.indexes).toEqual(auditFirst.indexes);
    expect(recoveryFirst.triggers).toEqual(auditFirst.triggers);
    expect(recoveryFirst.routines).toEqual(auditFirst.routines);
    expect(recoveryFirst.privileges).toEqual(auditFirst.privileges);
    expect(recoveryFirst.comments).toEqual(auditFirst.comments);
    expect(recoveryFirst.routinePrivileges).toEqual(
      auditFirst.routinePrivileges,
    );
    expect(recoveryFirst.schemaPrivileges).toEqual(auditFirst.schemaPrivileges);
    expect([...recoveryFirst.ledger].sort()).toEqual(
      [...auditFirst.ledger].sort(),
    );
  });

  it("keeps migration 022 objects identical in every proven order", () => {
    const sliceOneAdmin = selectAdminObjects(sliceOne);
    const recoveryFirstAdmin = selectAdminObjects(recoveryFirst);
    const auditFirstAdmin = selectAdminObjects(auditFirst);

    // Non-vacuity: every compared leg 022 actually populates must be non-empty,
    // otherwise this would be comparing empty arrays.
    expect(sliceOneAdmin.columns.length).toBeGreaterThan(0);
    expect(sliceOneAdmin.constraints.length).toBeGreaterThan(0);
    expect(sliceOneAdmin.triggers.length).toBeGreaterThan(0);
    expect(sliceOneAdmin.routines.length).toBeGreaterThan(0);
    expect(sliceOneAdmin.indexes.length).toBeGreaterThan(0);
    expect(sliceOneAdmin.privileges.length).toBeGreaterThan(0);
    expect(sliceOneAdmin.routinePrivileges.length).toBeGreaterThan(0);
    // Migration 022 sets five COMMENT ON statements: four tables plus the
    // audit-mutation trigger function.
    expect(sliceOneAdmin.comments.length).toBe(5);

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
      // The migrator runs every pending file inside ONE transaction and creates
      // the ledger table inside that same transaction, so a refused migration
      // rolls back the ledger's creation too. Absent table and present-but-
      // without-022 are both correct outcomes; the absent table is the stronger
      // one, because it proves nothing at all was committed.
      //
      // The ledger creation cannot be hoisted out of the transaction to make
      // this simpler: concurrent CREATE TABLE IF NOT EXISTS races on
      // pg_type_typname_nsp_index, which is why it lives inside.
      const ledgerExists = await scenarioPool.query<{ exists: boolean }>(
        "SELECT to_regclass('migrations') IS NOT NULL AS exists",
      );

      if (ledgerExists.rows[0]?.exists) {
        const applied = await scenarioPool.query<{ name: string }>(
          "SELECT name FROM migrations ORDER BY id",
        );
        expect(applied.rows.map((row) => row.name)).not.toContain(
          ADMIN_AUDIT_MIGRATION,
        );
      }

      // Independent of the ledger: 022's own objects must not survive a refused
      // run. This is the assertion that actually matters, and it holds whether
      // or not the ledger table was rolled back with it.
      const adminObjects = await scenarioPool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_tables
          WHERE schemaname = current_schema()
            AND tablename LIKE 'admin\\_%'`,
      );
      expect(adminObjects.rows[0]?.count).toBe("0");
    } finally {
      await scenarioPool.end();
    }
  }, 180_000);

  it("stages byte-identical copies of the real repository migrations", async () => {
    const staged = await stage("identity", upToJit);
    const files = await readdir(staged);
    expect(files).toContain(JIT_FOUNDATION_MIGRATION);
    expect(files).not.toContain(ADMIN_AUDIT_MIGRATION);

    const full = await stage("identity_full", everything);
    const fullFiles = await readdir(full);
    expect(fullFiles).toContain(ADMIN_AUDIT_MIGRATION);
    expect(fullFiles).toContain(JIT_RECOVERY_MIGRATION);

    // Filenames alone would not detect a rewritten or substituted body, which
    // is the exact failure the integration gate has to exclude. Compare
    // content digests against db/migrations.
    for (const migration of [
      JIT_FOUNDATION_MIGRATION,
      ADMIN_AUDIT_MIGRATION,
      JIT_RECOVERY_MIGRATION,
    ]) {
      const repositoryBytes = await readFile(
        join(migrationsDirectory, migration),
      );
      const stagedBytes = await readFile(join(full, migration));
      expect(repositoryBytes.length).toBeGreaterThan(0);
      expect(createHash("sha256").update(stagedBytes).digest("hex")).toBe(
        createHash("sha256").update(repositoryBytes).digest("hex"),
      );
    }
  });
});

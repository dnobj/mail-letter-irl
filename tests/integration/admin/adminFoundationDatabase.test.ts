import { randomUUID } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseAdminEnvironmentConfig } from "../../../src/admin/config.js";
import { buildAdminGrantStatements } from "../../../src/admin/provisioning.js";
import {
  ADMIN_MIGRATION_SEQUENCE,
  validDevelopmentAdminConfig,
} from "../../fixtures/admin.js";

const databaseUrl = process.env.LETTER_IRL_ADMIN_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]+$/.test(identifier)) {
    throw new Error("Unsafe test schema identifier");
  }
  return `"${identifier}"`;
}

describeWithDatabase("admin foundation database migration", () => {
  const schemaName = `admin_foundation_${randomUUID().replace(/-/g, "")}`;
  const schemaIdentifier = quoteIdentifier(schemaName);
  const migrationsDirectory = join(process.cwd(), "db", "migrations");
  let pool: InstanceType<typeof Pool>;
  let client: PoolClient;

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

    // The JIT foundation migration is read from this repository only. An
    // external or synthetic substitute would invalidate the 021 -> 022 proof.
    const jitMigrationPath = join(
      migrationsDirectory,
      ADMIN_MIGRATION_SEQUENCE[0],
    );
    await access(jitMigrationPath);

    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    client = await pool.connect();
    await client.query(`CREATE SCHEMA ${schemaIdentifier}`);
    await client.query(`SET search_path TO ${schemaIdentifier}`);
    await client.query(`
      CREATE TABLE migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((filename) => {
        const sequence = Number(filename.slice(0, 3));
        return filename.endsWith(".sql") && sequence >= 1 && sequence <= 20;
      })
      .sort();

    for (const filename of migrationFiles) {
      await client.query(
        await readFile(join(migrationsDirectory, filename), "utf8"),
      );
      await client.query("INSERT INTO migrations (name) VALUES ($1)", [
        filename,
      ]);
    }

    await client.query(await readFile(jitMigrationPath, "utf8"));
    await client.query("INSERT INTO migrations (name) VALUES ($1)", [
      ADMIN_MIGRATION_SEQUENCE[0],
    ]);

    const adminMigrationPath = join(
      migrationsDirectory,
      ADMIN_MIGRATION_SEQUENCE[1],
    );
    await client.query(await readFile(adminMigrationPath, "utf8"));
    await client.query("INSERT INTO migrations (name) VALUES ($1)", [
      ADMIN_MIGRATION_SEQUENCE[1],
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("RESET ROLE");
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA ${schemaIdentifier} CASCADE`);
    await client.query(
      'DROP ROLE IF EXISTS "letter_irl_admin_reader_development", "letter_irl_admin_operator_development"',
    );
    client.release();
    await pool.end();
  });

  async function insertCommand(idempotencyKey: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO admin_command_runs (
          idempotency_key,
          actor_sid,
          environment,
          action,
          target_type,
          target_id,
          preview_digest,
          expected_version,
          correlation_id
        )
        VALUES ($1, 'S-1-5-21-1000', 'development', 'fixture.update',
                'fixture', 'fixture-1', $2, '1', $3)
        RETURNING id
      `,
      [idempotencyKey, "a".repeat(64), randomUUID()],
    );
    return result.rows[0].id;
  }

  it("applies 022 after the distinct JIT migration 021 and preserves old application reads", async () => {
    const applied = await client.query<{ name: string }>(
      "SELECT name FROM migrations ORDER BY id DESC LIMIT 2",
    );
    expect(applied.rows.map((row) => row.name).reverse()).toEqual(
      ADMIN_MIGRATION_SEQUENCE,
    );

    await client.query(
      `
        INSERT INTO users (user_id, email)
        VALUES ('admin-foundation-fixture', 'admin-foundation@example.test')
      `,
    );
    const oldApplicationRead = await client.query(
      `
        SELECT user_id, email, credits, credits_purchased, credits_used, created_at, updated_at
        FROM users
        WHERE user_id = 'admin-foundation-fixture'
      `,
    );
    expect(oldApplicationRead.rows).toHaveLength(1);
  });

  it("enforces one immutable environment marker", async () => {
    await client.query(
      `
        INSERT INTO admin_environment_marker (environment, configured_by)
        VALUES ('development', 'integration-test')
      `,
    );
    await expect(
      client.query(
        `
          INSERT INTO admin_environment_marker (environment, configured_by)
          VALUES ('production', 'integration-test')
        `,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces command and operation idempotency constraints", async () => {
    const commandId = await insertCommand("integration-idempotency-1");
    await expect(
      insertCommand("integration-idempotency-1"),
    ).rejects.toMatchObject({
      code: "23505",
    });

    await expect(
      client.query(
        `
          INSERT INTO admin_operations (
            command_id, operation_type, environment, payload_json
          )
          VALUES ($1, 'provider.fixture', 'production', '{}'::jsonb)
        `,
        [commandId],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await client.query(
      `
        INSERT INTO admin_operations (
          command_id, operation_type, environment, payload_json
        )
        VALUES ($1, 'provider.fixture', 'development', '{}'::jsonb)
      `,
      [commandId],
    );
    await expect(
      client.query(
        `
          INSERT INTO admin_operations (
            command_id, operation_type, environment, payload_json
          )
          VALUES ($1, 'provider.fixture', 'development', '{}'::jsonb)
        `,
        [commandId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects audit updates and deletes at the database boundary", async () => {
    const commandId = await insertCommand("integration-audit-immutable");
    const audit = await client.query<{ id: string }>(
      `
        INSERT INTO admin_audit_events (
          actor_sid,
          actor_name,
          environment,
          mode,
          session_id_hash,
          correlation_id,
          action,
          target_type,
          outcome,
          command_id
        )
        VALUES (
          'S-1-5-21-1000', 'operator', 'development', 'full', $1, $2,
          'fixture.update', 'fixture', 'succeeded', $3
        )
        RETURNING id
      `,
      ["b".repeat(64), randomUUID(), commandId],
    );

    await expect(
      client.query(
        "UPDATE admin_audit_events SET actor_name = $1 WHERE id = $2",
        ["rewritten", audit.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      client.query("DELETE FROM admin_audit_events WHERE id = $1", [
        audit.rows[0].id,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rolls back the command when its audit insert cannot commit atomically", async () => {
    const idempotencyKey = "integration-atomic-rollback";
    await client.query("BEGIN");
    try {
      const commandId = await insertCommand(idempotencyKey);
      await expect(
        client.query(
          `
            INSERT INTO admin_audit_events (
              actor_sid,
              actor_name,
              environment,
              mode,
              session_id_hash,
              correlation_id,
              action,
              target_type,
              outcome,
              command_id
            )
            VALUES (
              'S-1-5-21-1000', 'operator', 'development', 'full', 'invalid', $1,
              'fixture.update', 'fixture', 'succeeded', $2
            )
          `,
          [randomUUID(), commandId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
    }

    const persisted = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM admin_command_runs WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(persisted.rows[0].count).toBe("0");
  });

  const ADMIN_FOUNDATION_RELATIONS = [
    "admin_environment_marker",
    "admin_audit_events",
    "admin_command_runs",
    "admin_operations",
  ];

  /**
   * Counts PUBLIC grants from the relation's own stored ACL.
   *
   * Deliberately does NOT fall back to `acldefault()`. acldefault for a table
   * never contains a PUBLIC entry, so a COALESCE onto it reports zero for a
   * table that was never revoked at all, which makes the assertion pass with
   * migration 022's REVOKE statements deleted.
   */
  async function countPublicGrants(relation: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM pg_class AS rel
      JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
      CROSS JOIN LATERAL aclexplode(rel.relacl) AS privilege
      WHERE ns.nspname = $1 AND rel.relname = $2 AND privilege.grantee = 0
    `,
      [schemaName, relation],
    );
    return Number(result.rows[0].count);
  }

  it("revokes default public access to the admin foundation tables", async () => {
    for (const relation of ADMIN_FOUNDATION_RELATIONS) {
      // An explicit REVOKE materialises relacl. If migration 022 stopped
      // revoking, relacl stays NULL and this fails instead of silently
      // reporting zero PUBLIC grants.
      const stored = await client.query<{ relaclIsNull: boolean }>(
        `
        SELECT rel.relacl IS NULL AS "relaclIsNull"
        FROM pg_class AS rel
        JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = $1 AND rel.relname = $2
      `,
        [schemaName, relation],
      );
      expect(stored.rows).toHaveLength(1);
      expect(
        stored.rows[0].relaclIsNull,
        `${relation} has no stored ACL, so nothing was revoked`,
      ).toBe(false);

      expect(await countPublicGrants(relation)).toBe(0);
    }
  });

  it("detects a PUBLIC grant and confirms REVOKE removes it", async () => {
    // Positive control for the assertion above: without this round trip the
    // zero-PUBLIC-grant check could be green because the detector is broken
    // rather than because access is actually revoked.
    const relation = "admin_audit_events";
    expect(await countPublicGrants(relation)).toBe(0);

    await client.query(`GRANT SELECT ON ${relation} TO PUBLIC`);
    expect(await countPublicGrants(relation)).toBeGreaterThan(0);

    await client.query(`REVOKE ALL ON ${relation} FROM PUBLIC`);
    expect(await countPublicGrants(relation)).toBe(0);
  });

  it("applies least-privilege reader/operator grants and denies arbitrary writes", async () => {
    const config = parseAdminEnvironmentConfig(validDevelopmentAdminConfig);
    await client.query(`CREATE ROLE "${config.database.readerRole}" LOGIN`);
    await client.query(`CREATE ROLE "${config.database.operatorRole}" LOGIN`);
    for (const statement of buildAdminGrantStatements(config, schemaName)) {
      await client.query(statement);
    }

    await client.query(`SET ROLE "${config.database.readerRole}"`);
    await expect(
      client.query("SELECT user_id FROM users LIMIT 1"),
    ).resolves.toBeTruthy();
    await expect(
      client.query(
        "INSERT INTO users (user_id, email) VALUES ('reader-write', 'reader-write@example.test')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const readerAudit = await client.query<{ id: string }>(
      `
        INSERT INTO admin_audit_events (
          actor_sid, actor_name, environment, mode, session_id_hash,
          correlation_id, action, target_type, outcome
        )
        VALUES (
          'S-1-5-21-1000', 'reader', 'development', 'read-only', $1,
          $2, 'fixture.reveal', 'fixture', 'succeeded'
        )
        RETURNING id
      `,
      ["d".repeat(64), randomUUID()],
    );
    await expect(
      client.query(
        "UPDATE admin_audit_events SET actor_name = 'rewrite' WHERE id = $1",
        [readerAudit.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("RESET ROLE");

    await client.query(`SET ROLE "${config.database.operatorRole}"`);
    await expect(
      client.query(
        "INSERT INTO users (user_id, email) VALUES ('operator-write', 'operator-write@example.test')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      insertCommand("operator-foundation-command"),
    ).resolves.toBeTruthy();
    await client.query("RESET ROLE");
  });
});

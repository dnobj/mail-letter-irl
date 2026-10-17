import { describe, expect, it, vi } from "vitest";
import { readReaderSeparation, verifyReaderSeparation } from "../../../src/admin/db.js";

const CLEAN = {
  letters_content: false,
  letters_recipient: false,
  draft_body: false,
  return_address: false,
  token_hash: false,
  letter_preview: false,
  address_requests: false,
  unrestricted: false,
  privileged_member: false,
  owner_member: false,
};

function client(row: Record<string, boolean> | null) {
  return { query: vi.fn(async (..._args: unknown[]) => ({ rows: row ? [row] : [] })) };
}

describe("the admin reader role's column separation (#730)", () => {
  it("passes a role that reads only its granted columns, asking about it by name", async () => {
    const db = client(CLEAN);
    await expect(verifyReaderSeparation(db as never, "reader_role")).resolves.toBeUndefined();
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["reader_role"]);
    expect(sql).toContain("WHERE r.rolname = $1::name");
    for (const probe of [
      "has_column_privilege(r.oid, 'letters', 'content', 'SELECT')",
      "has_column_privilege(r.oid, 'letters', 'recipient', 'SELECT')",
      "has_column_privilege(r.oid, 'letter_drafts', 'body_text', 'SELECT')",
      "has_column_privilege(r.oid, 'users', 'return_address', 'SELECT')",
      "has_column_privilege(r.oid, 'personal_access_tokens', 'token_hash', 'SELECT')",
      "r.rolsuper OR r.rolbypassrls",
      "'pg_read_all_data', 'neon_superuser'",
      "OR has_column_privilege(member_of.oid, 'letters', 'content', 'SELECT')",
      "OR has_column_privilege(member_of.oid, 'personal_access_tokens', 'token_hash', 'SELECT')",
      "has_column_privilege(r.oid, 'letters', 'preview_html', 'SELECT')",
      "to_regclass('address_requests')",
      // A column grant to the reader is caught as a table grant is (#701).
      "has_any_column_privilege(r.oid, c.oid, 'SELECT')",
      "member_of.oid <> r.oid",
      "pg_has_role(r.oid, (SELECT relowner FROM pg_class WHERE oid = 'letters'::regclass), 'MEMBER')",
    ]) {
      expect(sql, probe).toContain(probe);
    }
  });

  it.each(Object.keys(CLEAN))("refuses a role whose %s is true", async (key) => {
    await expect(verifyReaderSeparation(client({ ...CLEAN, [key]: true }) as never, "reader_role")).rejects.toMatchObject({
      code: "ADMIN_READER_ROLE_TOO_WIDE",
    });
  });

  it("refuses a role that does not exist", async () => {
    await expect(verifyReaderSeparation(client(null) as never, "nobody")).rejects.toMatchObject({ code: "ADMIN_READER_ROLE_TOO_WIDE" });
    await expect(readReaderSeparation(client(null) as never, "nobody")).resolves.toBeNull();
  });

  it("names each finding", async () => {
    await expect(readReaderSeparation(client({ ...CLEAN, owner_member: true }) as never, "r")).resolves.toEqual({
      readsLetterContent: false,
      readsLetterRecipient: false,
      readsDraftBody: false,
      readsReturnAddress: false,
      readsTokenHash: false,
      readsLetterPreview: false,
      readsAddressRequests: false,
      unrestricted: false,
      privilegedMember: false,
      ownerMember: true,
    });
  });
});

describe("where the separation is checked", () => {
  it("at boot, after the reader's identity, and when provisioning, before the commit", async () => {
    const { readFileSync } = await import("node:fs");
    const server = readFileSync("src/admin/server.ts", "utf8");
    const identity = server.indexOf("const readerIdentity = await verifyDatabaseIdentity(pools.reader");
    const separation = server.indexOf("await verifyReaderSeparation(pools.reader, readerIdentity.roleName);");
    expect(identity).toBeGreaterThan(-1);
    expect(separation).toBeGreaterThan(identity);
    const script = readFileSync("scripts/provisionAdminDatabaseAccess.ts", "utf8");
    const check = script.indexOf("await verifyReaderSeparation(client, config.database.readerRole);");
    const commit = script.indexOf('await client.query("COMMIT");', check);
    expect(check).toBeGreaterThan(script.indexOf("buildAdminGrantStatements(config)"));
    expect(commit).toBeGreaterThan(check);
  });
});

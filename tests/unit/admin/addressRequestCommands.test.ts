import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  addressRequestDeleteCommand,
  addressRequestPreviewPath,
  addressRequestTarget,
} from "../../../src/admin/commands/addressRequests.js";
import { ADMIN_COMMANDS } from "../../../src/admin/commands/index.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";
import { renderSupport } from "../../../src/admin/pages/ops.js";

/**
 * address_request.delete (#701): an address request deleted on request, named
 * by its link's fingerprint or its id. The panel reads no address request, so
 * the preview reads nothing, and the delete reads back only a status and a
 * time; the token never reaches a URL or the audit.
 */

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";
const HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const REQUEST_ID = "4b8f2c1e-9d3a-4e7b-8c5f-1a2b3c4d5e6f";

const execution = (client: unknown) => ({
  commandId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "admin:22222222-2222-4222-8222-222222222222",
  actorId: "owner@example.com",
  environment: "development" as const,
  reason: "the recipient asked",
  client: client as never,
});

describe("what names an address request (#701)", () => {
  it("reduces a pasted link, or its bare token, to the link's fingerprint", () => {
    expect(addressRequestTarget(`https://www.example.com/address#${TOKEN}`)).toBe(`link:${HASH}`);
    expect(addressRequestTarget(`  ${TOKEN}  `)).toBe(`link:${HASH}`);
    expect(addressRequestTarget(`https://www.example.com/address#${TOKEN}`)).not.toContain(TOKEN);
  });

  it("takes a request id in either case, as lower case", () => {
    expect(addressRequestTarget(REQUEST_ID.toUpperCase())).toBe(`request:${REQUEST_ID}`);
  });

  it("names nothing for anything else", () => {
    for (const pasted of ["", "hello", "https://www.example.com/address#short", `${TOKEN}x`, "4b8f2c1e-9d3a-4e7b-8c5f", `https://www.example.com/address#${TOKEN}#extra`]) {
      expect(addressRequestTarget(pasted), pasted).toBeNull();
    }
  });

  it("sends the Support form to the delete's preview by fingerprint, never with the token", () => {
    const path = addressRequestPreviewPath(`https://www.example.com/address#${TOKEN}`)!;
    expect(path).toBe(`/commands/address_request.delete/preview?target=${encodeURIComponent(`link:${HASH}`)}`);
    expect(path).not.toContain(TOKEN);
    expect(addressRequestPreviewPath("not a link")).toBeNull();
  });

  it("puts the form on the Support page as a POST carrying the CSRF token", () => {
    const page = renderSupport({
      tokenStats: { total: 0, active: 0, revoked: 0, usedToday: 0, usedLast7Days: 0 },
      featureRequests: [],
      csrfToken: "c".repeat(64),
    } as never).value;
    expect(page).toContain('<form method="post" action="/support/address-request">');
    expect(page).toContain(`name="_csrf" value="${"c".repeat(64)}"`);
    expect(page).toContain('name="request"');
  });
});

describe("address_request.delete (#701)", () => {
  it("is registered, transactional, and confirms with its own verb", () => {
    expect(ADMIN_COMMANDS).toContain(addressRequestDeleteCommand);
    expect(addressRequestDeleteCommand.name).toBe("address_request.delete");
    expect(addressRequestDeleteCommand.transactional).toBe(true);
    expect(addressRequestDeleteCommand.verb({})).toBe("DELETE-ADDRESS-REQUEST");
  });

  it("previews without reading anything, and says the result will tell", async () => {
    const reader = { query: vi.fn() } as unknown as AdminSqlClient;
    const byLink = await addressRequestDeleteCommand.preview(reader, `link:${HASH.toUpperCase()}`, {});
    expect(byLink.targetId).toBe(`link:${HASH}`);
    expect(byLink.summary).toEqual({ by: "link" });
    expect(byLink.display[0][1]).toContain(HASH.slice(0, 12));
    expect(byLink.warnings.join(" ")).toContain("the result says whether one was found");
    const byId = await addressRequestDeleteCommand.preview(reader, `request:${REQUEST_ID}`, {});
    expect(byId.summary).toEqual({ by: "request" });
    expect(reader.query).not.toHaveBeenCalled();
  });

  it("refuses a target that is neither a fingerprint nor an id", async () => {
    const reader = { query: vi.fn() } as unknown as AdminSqlClient;
    for (const target of [TOKEN, `link:${HASH.slice(1)}`, `request:${REQUEST_ID.slice(1)}`, "user:auth0|x", ""]) {
      await expect(addressRequestDeleteCommand.preview(reader, target, {}), target).rejects.toMatchObject({ code: "ADMIN_INVALID_REQUEST" });
      await expect(addressRequestDeleteCommand.execute(execution({ query: vi.fn() }), target, {}, {} as never), target).rejects.toMatchObject({
        code: "ADMIN_INVALID_REQUEST",
      });
    }
  });

  it("deletes by the link's hash, reading back only the status and when it was made", async () => {
    const query = vi.fn(async () => ({ rows: [{ status: "answered", created_at: new Date("2026-10-09T14:00:00.000Z") }] }));
    const result = await addressRequestDeleteCommand.execute(execution({ query }), `link:${HASH}`, {}, {} as never);
    expect(result).toEqual({ deleted: true, status: "answered", createdAt: "2026-10-09T14:00:00.000Z" });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toBe("DELETE FROM address_requests WHERE token_hash = decode($1, 'hex') RETURNING status, created_at");
    expect(params).toEqual([HASH]);
  });

  it("deletes by id, and says when none was found", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await addressRequestDeleteCommand.execute(execution({ query }), `request:${REQUEST_ID}`, {}, {} as never)).toEqual({ deleted: false });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toBe("DELETE FROM address_requests WHERE request_id = $1::uuid RETURNING status, created_at");
    expect(params).toEqual([REQUEST_ID]);
  });

  it("never names the recipient, the sender or the address", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await addressRequestDeleteCommand.execute(execution({ query }), `link:${HASH}`, {}, {} as never);
    const sql = String((query.mock.calls[0] as unknown[])[0]);
    for (const column of ["address", "recipient_name", "sender_first_name"]) {
      expect(sql.replace("address_requests", "")).not.toContain(column);
    }
  });

  it("needs the operator transaction", async () => {
    await expect(addressRequestDeleteCommand.execute(execution(null), `link:${HASH}`, {}, {} as never)).rejects.toMatchObject({
      code: "ADMIN_INTERNAL_ERROR",
    });
  });
});

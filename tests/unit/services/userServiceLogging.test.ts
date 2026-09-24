import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/index.js", () => ({
  query: vi.fn()
}));

import { query } from "../../../src/db/index.js";
import { getOrCreateUser } from "../../../src/services/userService.js";
import { AccountErasedError } from "../../../src/auth/accountErased.js";

const rawSubject = "auth0|real-persistence-subject";
const oldEmail = "old-private@example.com";
const newEmail = "new-private@example.com";

function queryResult(rows: unknown[]) {
  return {
    rows,
    rowCount: rows.length,
    command: "SELECT",
    oid: 0,
    fields: []
  };
}

describe("real user persistence diagnostics", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("creates through the real service without logging subject or email", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([]) as never)
      .mockResolvedValueOnce(
        queryResult([{ user_id: rawSubject, email: newEmail }]) as never
      );

    await getOrCreateUser(rawSubject, newEmail);

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain('"event":"identity.user_created"');
    expect(output).not.toContain(rawSubject);
    expect(output).not.toContain(newEmail);
  });

  it("updates email through the real service without logging either value", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(query)
      .mockResolvedValueOnce(
        queryResult([{ user_id: rawSubject, email: oldEmail }]) as never
      )
      .mockResolvedValueOnce(
        queryResult([{ user_id: rawSubject, email: newEmail }]) as never
      );

    await getOrCreateUser(rawSubject, newEmail);

    const output = log.mock.calls.flat().map(String).join("\n");
    expect(output).toContain('"event":"identity.email_updated"');
    expect(output).not.toContain(rawSubject);
    expect(output).not.toContain(oldEmail);
    expect(output).not.toContain(newEmail);
  });

  it("refuses an erased account before writing its address back (#289)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(query).mockResolvedValueOnce(
      queryResult([
        { user_id: rawSubject, email: "erased-1b9d6bcd@erased.invalid", erased_at: new Date() }
      ]) as never
    );

    await expect(getOrCreateUser(rawSubject, newEmail)).rejects.toBeInstanceOf(AccountErasedError);

    // One read and no UPDATE: the tombstone keeps its placeholder.
    expect(query).toHaveBeenCalledTimes(1);
    const output = warn.mock.calls.flat().map(String).join("\n");
    expect(output).toContain('"event":"identity.account_erased_refused"');
    expect(output).not.toContain(rawSubject);
    expect(output).not.toContain(newEmail);
  });
});

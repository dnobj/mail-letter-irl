import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/index.js", () => ({
  query: vi.fn()
}));

import { query } from "../../../src/db/index.js";
import { createUser, EmailAlreadyLinkedError, getOrCreateUser } from "../../../src/services/userService.js";
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

describe("a first insert that finds a conflict (#457)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("skips the insert on any unique index, so no conflict raises", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([]) as never)
      .mockResolvedValueOnce(queryResult([{ user_id: rawSubject, email: newEmail }]) as never);

    await createUser({ userId: rawSubject, email: newEmail });

    const insert = String(vi.mocked(query).mock.calls[0][0]).replace(/\s+/g, " ");
    // No conflict target: a target arbitrates only its own index, and the
    // email index outside it raised for the same subject's second request.
    expect(insert).toContain("ON CONFLICT DO NOTHING");
    expect(insert).not.toContain("ON CONFLICT (");
  });

  it("answers a race it lost with the winner's row, and names no collision", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const winner = { user_id: rawSubject, email: newEmail };
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([]) as never)
      .mockResolvedValueOnce(queryResult([winner]) as never);

    await expect(createUser({ userId: rawSubject, email: newEmail })).resolves.toBe(winner);

    // The subject's own row settled it: the address was never looked up.
    expect(query).toHaveBeenCalledTimes(2);
    const output = [...warn.mock.calls, ...log.mock.calls].flat().map(String).join("\n");
    expect(output).not.toContain("identity.email_already_linked");
    expect(output).not.toContain("identity.user_created");
  });

  it("names the collision when another subject holds the address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([]) as never)
      .mockResolvedValueOnce(queryResult([]) as never)
      .mockResolvedValueOnce(queryResult([{ user_id: "auth0|another-method", email: newEmail }]) as never);

    await expect(createUser({ userId: rawSubject, email: newEmail })).rejects.toBeInstanceOf(
      EmailAlreadyLinkedError
    );

    const lookup = vi.mocked(query).mock.calls[2];
    expect(String(lookup[0])).toContain("WHERE email = $1");
    expect(lookup[1]).toEqual([newEmail]);
    const output = warn.mock.calls.flat().map(String).join("\n");
    expect(output).toContain('"event":"identity.email_already_linked"');
    expect(output).not.toContain(rawSubject);
    expect(output).not.toContain(newEmail);
  });

  it("fails plainly when the insert was skipped but neither row is there", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([]) as never)
      .mockResolvedValueOnce(queryResult([]) as never)
      .mockResolvedValueOnce(queryResult([]) as never);

    const failure = createUser({ userId: rawSubject, email: newEmail });
    await expect(failure).rejects.toThrow("User not found");
    await expect(failure).rejects.not.toBeInstanceOf(EmailAlreadyLinkedError);
  });
});

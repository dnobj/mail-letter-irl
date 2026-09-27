import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The erasure worker's control flow over a scripted client (#289): which
 * outcome becomes which operation state, when a failure is retried and when
 * it is final, and that a failure is taken back to the savepoint before the
 * attempt is recorded. The SQL itself - the gate, the scrubs, the constraints
 * they must satisfy - is proven against PostgreSQL in
 * tests/integration/accountErasure.postgres.test.ts.
 */

const db = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn() }));
vi.mock("../../../src/db/index.js", () => db);
// The photo an account uploaded through our card lives in the image store (#474).
const store = vi.hoisted(() => ({ deleteUploadedPhoto: vi.fn(async (_userId: string) => undefined) }));
vi.mock("../../../src/services/tempImageStore.js", () => store);

import {
  MAX_ERASURE_ATTEMPTS,
  UPLOADED_PHOTO_DELETE_TIMEOUT_MS,
  erasureBlocked,
  processAccountErasures
} from "../../../src/services/accountErasureService.js";

interface Operation {
  id: string;
  payload_json: unknown;
  attempts: number;
}

interface Script {
  queue: Operation[];
  account?: { erased_at: Date | null } | null;
  blockers?: Record<string, number>;
  failOn?: RegExp;
  /** The SQLSTATE the scripted failure carries; a check violation unless a test says otherwise. */
  failCode?: string;
}

const CLEAR = {
  orders_in_flight: 0,
  letters_in_flight: 0,
  jobs_in_flight: 0,
  disputes_open: 0,
  refunds_in_flight: 0,
  images_in_flight: 0
};

function scriptedClient(script: Script) {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    statements,
    async query(text: string, values?: unknown[]) {
      statements.push({ text, values });
      if (script.failOn?.test(text)) throw Object.assign(new Error("relation is locked"), { code: script.failCode ?? "23514" });
      if (text.includes("FROM admin_operations o")) {
        const next = script.queue.shift();
        return { rows: next ? [next] : [], rowCount: next ? 1 : 0 };
      }
      if (text.startsWith("SELECT erased_at FROM users")) {
        const account = script.account === undefined ? { erased_at: null } : script.account;
        return { rows: account ? [account] : [], rowCount: account ? 1 : 0 };
      }
      if (text.includes("AS orders_in_flight")) {
        return { rows: [{ ...CLEAR, ...(script.blockers ?? {}) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 2 };
    }
  };
  db.transaction.mockImplementation(async (callback: (c: typeof client) => Promise<unknown>) => callback(client));
  return client;
}

function operationUpdates(client: ReturnType<typeof scriptedClient>) {
  return client.statements.filter((statement) => statement.text.includes("UPDATE admin_operations"));
}

const OPERATION = (attempts = 0): Operation => ({ id: "op-1", payload_json: { userId: "auth0|gone" }, attempts });

beforeEach(() => {
  db.transaction.mockReset();
  db.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("processing queued erasures", () => {
  it("erases, records the counts, and stops when the queue is empty", async () => {
    const client = scriptedClient({ queue: [OPERATION()] });

    expect(await processAccountErasures()).toEqual({ erased: 1, refused: 0, retrying: 0, failed: 0 });

    const [done] = operationUpdates(client);
    expect(done.text).toMatch(/status = 'succeeded'/);
    expect(done.values?.[0]).toBe("op-1");
    const counts = JSON.parse(String(done.values?.[1]));
    expect(counts).toMatchObject({ lettersScrubbed: 2, accessTokensDeleted: 2, descriptionsCleared: 4 });
    // Every write ran under the savepoint, and nothing was rolled back.
    expect(client.statements.some((s) => s.text === "SAVEPOINT admin_operation")).toBe(true);
    expect(client.statements.some((s) => s.text.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(false);
    // The tombstone is written last, after every scrub that finds the account.
    const writes = client.statements.map((s) => s.text);
    expect(writes.findIndex((t) => t.includes("SET email = 'erased-'"))).toBeGreaterThan(
      writes.findIndex((t) => t.includes("DELETE FROM gift_codes"))
    );
    // The operator's follow-up comes after the tombstone, inside the same
    // savepoint, and names the account by its id alone (#453).
    const alerts = client.statements.filter((s) => s.text.includes("INSERT INTO commerce_operational_alerts"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].values).toEqual(["account_erasure_followup", "auth0|gone"]);
    expect(writes.findIndex((t) => t.includes("INSERT INTO commerce_operational_alerts"))).toBeGreaterThan(
      writes.findIndex((t) => t.includes("SET email = 'erased-'"))
    );
    // Two transactions: the operation, then the empty claim that ends the run.
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it("claims only this database's own environment, one operation at a time, past any another run holds", async () => {
    const client = scriptedClient({ queue: [] });
    await processAccountErasures();
    const claim = client.statements.find((s) => s.text.includes("FROM admin_operations o"))!.text.replace(/\s+/g, " ");
    expect(claim).toContain("AND o.environment = (SELECT m.environment FROM admin_environment_marker m)");
    expect(claim).toContain("AND o.status = 'pending' AND o.available_at <= NOW()");
    expect(claim).toContain("LIMIT 1 FOR UPDATE OF o SKIP LOCKED");
  });

  it("deletes the saved copies before the drafts they are found through", async () => {
    const client = scriptedClient({ queue: [OPERATION()] });
    await processAccountErasures();
    const writes = client.statements.map((s) => s.text);
    expect(writes.findIndex((t) => t.includes("DELETE FROM redacted_content_quarantine"))).toBeLessThan(
      writes.findIndex((t) => t.includes("DELETE FROM letter_drafts"))
    );
  });

  it("takes at most the batch it is given", async () => {
    scriptedClient({ queue: [OPERATION(), { ...OPERATION(), id: "op-2" }, { ...OPERATION(), id: "op-3" }] });
    expect(await processAccountErasures(2)).toEqual({ erased: 2, refused: 0, retrying: 0, failed: 0 });
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it("refuses, writing nothing, when the gate finds money or mail in flight", async () => {
    const client = scriptedClient({ queue: [OPERATION()], blockers: { orders_in_flight: 1 } });

    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 1, retrying: 0, failed: 0 });

    const [refused] = operationUpdates(client);
    expect(refused.text).toMatch(/status = 'failed'/);
    expect(refused.values?.[1]).toBe("ACCOUNT_ERASURE_BLOCKED");
    expect(JSON.parse(String(refused.values?.[2]))).toMatchObject({ ordersInFlight: 1 });
    expect(client.statements.some((s) => /^\s*(UPDATE letters|DELETE|UPDATE users)/.test(s.text))).toBe(false);
    expect(client.statements.some((s) => s.text.includes("INSERT INTO commerce_operational_alerts"))).toBe(false);
  });

  it("refuses an operation whose account is gone, or whose payload names none", async () => {
    const gone = scriptedClient({ queue: [OPERATION()], account: null });
    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 1, retrying: 0, failed: 0 });
    expect(operationUpdates(gone)[0].values?.[1]).toBe("ACCOUNT_ERASURE_NOT_FOUND");

    const nameless = scriptedClient({ queue: [{ id: "op-9", payload_json: { userId: "" }, attempts: 0 }] });
    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 1, retrying: 0, failed: 0 });
    expect(operationUpdates(nameless)[0].values?.[1]).toBe("ACCOUNT_ERASURE_NOT_FOUND");
    // It never went looking for an account to erase.
    expect(nameless.statements.some((s) => s.text.includes("FROM users"))).toBe(false);
  });

  it("counts an account erased by an earlier run as done, not as a failure", async () => {
    const client = scriptedClient({ queue: [OPERATION()], account: { erased_at: new Date() } });
    expect(await processAccountErasures()).toEqual({ erased: 1, refused: 0, retrying: 0, failed: 0 });
    const [done] = operationUpdates(client);
    expect(done.text).toMatch(/status = 'succeeded'/);
    expect(JSON.parse(String(done.values?.[1]))).toEqual({ alreadyErased: true });
    // The earlier run opened the follow-up; this one opens no second.
    expect(client.statements.some((s) => s.text.includes("INSERT INTO commerce_operational_alerts"))).toBe(false);
  });

  it("says in the completed diagnostic whether the erasure found anything left to do (#450 review)", async () => {
    const completed = () =>
      vi
        .mocked(console.log)
        .mock.calls.map(([line]) => JSON.parse(String(line)))
        .filter((line) => line.event === "account_erasure.completed");

    scriptedClient({ queue: [OPERATION()] });
    await processAccountErasures();
    expect(completed()).toEqual([expect.objectContaining({ alreadyErased: false })]);

    vi.mocked(console.log).mockClear();
    scriptedClient({ queue: [OPERATION()], account: { erased_at: new Date() } });
    await processAccountErasures();
    expect(completed()).toEqual([expect.objectContaining({ alreadyErased: true })]);
  });

  it("takes a failure back to the savepoint and retries it an hour later", async () => {
    const client = scriptedClient({ queue: [OPERATION(0)], failOn: /^\s*UPDATE letters\b/ });

    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 1, failed: 0 });

    const texts = client.statements.map((s) => s.text);
    const failedAt = texts.findIndex((t) => /^\s*UPDATE letters\b/.test(t));
    const rollback = texts.indexOf("ROLLBACK TO SAVEPOINT admin_operation");
    expect(rollback).toBeGreaterThan(failedAt);
    const [retry] = operationUpdates(client);
    expect(texts.indexOf(retry.text)).toBeGreaterThan(rollback);
    expect(retry.text).toMatch(/available_at = NOW\(\) \+ INTERVAL '1 hour'/);
    expect(retry.text).not.toMatch(/status = 'failed'/);
    // A class, never the driver's words.
    expect(JSON.parse(String(retry.values?.[1]))).toEqual({ lastErrorClass: expect.any(String) });
    expect(String(retry.values?.[1])).not.toContain("relation is locked");
  });

  it("gives up on the last attempt", async () => {
    const client = scriptedClient({ queue: [OPERATION(MAX_ERASURE_ATTEMPTS - 1)], failOn: /^\s*UPDATE letters\b/ });

    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 0, failed: 1 });

    const [final] = operationUpdates(client);
    expect(final.text).toMatch(/status = 'failed'/);
    expect(final.values?.[1]).toBe('ACCOUNT_ERASURE_ERROR');
    expect(MAX_ERASURE_ATTEMPTS).toBe(3);
  });

  it("retries on every attempt before the last", async () => {
    scriptedClient({ queue: [OPERATION(MAX_ERASURE_ATTEMPTS - 2)], failOn: /^\s*UPDATE letters\b/ });
    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 1, failed: 0 });
  });
});

describe("the gate", () => {
  it("holds for any count above zero and for none at zero", () => {
    const clear = {
      ordersInFlight: 0,
      lettersInFlight: 0,
      jobsInFlight: 0,
      disputesOpen: 0,
      refundsInFlight: 0,
      imagesInFlight: 0
    };
    expect(erasureBlocked(clear)).toBe(false);
    for (const key of Object.keys(clear) as Array<keyof typeof clear>) {
      expect(erasureBlocked({ ...clear, [key]: 1 }), key).toBe(true);
    }
  });
});

describe("what a failure costs (#446 review)", () => {
  it.each(["40P01", "55P03", "40001"])(
    "retries a lock conflict (%s) at the next run without spending an attempt, even on the last one",
    async (failCode) => {
      const client = scriptedClient({
        queue: [OPERATION(MAX_ERASURE_ATTEMPTS - 1)],
        failOn: /^\s*UPDATE letters\b/,
        failCode
      });

      expect(await processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 1, failed: 0 });

      const texts = client.statements.map((s) => s.text);
      expect(texts.indexOf("ROLLBACK TO SAVEPOINT admin_operation")).toBeGreaterThan(-1);
      const [retry] = operationUpdates(client);
      expect(retry.text).toMatch(/available_at = NOW\(\) \+ INTERVAL '1 hour'/);
      expect(retry.text).not.toMatch(/attempts = attempts \+ 1/);
      expect(retry.text).not.toMatch(/status = 'failed'/);
      // A class, never the driver's words.
      expect(JSON.parse(String(retry.values?.[1]))).toEqual({ lastErrorClass: expect.any(String) });
      expect(String(retry.values?.[1])).not.toContain("relation is locked");
    }
  );

  it("counts an attempt whose own bookkeeping failed, outside the rolled-back transaction, and stops the run", async () => {
    // The outcome's UPDATE fails: the real transaction helper rolls back
    // everything, the erasure included, and rethrows - as this one does by
    // passing the callback's rejection through. So the attempt is recorded in
    // a statement of its own.
    const fake = scriptedClient({ queue: [OPERATION(0), { ...OPERATION(0), id: "op-2" }], failOn: /status = 'succeeded'/ });

    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 1, failed: 0 });

    // One claim only: the run stopped rather than take the next operation.
    expect(fake.statements.filter((s) => s.text.includes("FROM admin_operations o"))).toHaveLength(1);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/attempts = attempts \+ 1/);
    expect(sql).toMatch(/WHERE id = \$1 AND status = 'pending'/);
    // The cap is decided from the row, and the class is kept either way.
    expect(sql).toContain("status = CASE WHEN attempts + 1 >= $2::int THEN 'failed'");
    // The final attempt keeps {errorClass}, a retry {lastErrorClass}, as inside the transaction.
    expect(sql).toContain("sanitized_result_json = CASE WHEN attempts + 1 >= $2::int THEN $4::jsonb ELSE $3::jsonb END");
    expect(values).toEqual(["op-1", MAX_ERASURE_ATTEMPTS, expect.any(String), expect.any(String), "ACCOUNT_ERASURE_ERROR"]);
    expect(JSON.parse(String(values[2]))).toEqual({ lastErrorClass: expect.any(String) });
    expect(JSON.parse(String(values[3]))).toEqual({ errorClass: expect.any(String) });
    expect(String(values[2])).not.toContain("relation is locked");
  });

  it("fails the operation outright when that was its last attempt", async () => {
    scriptedClient({ queue: [OPERATION(MAX_ERASURE_ATTEMPTS - 1)], failOn: /status = 'succeeded'/ });

    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 0, failed: 1 });
  });

  it("believes the row over the count read at the claim", async () => {
    // A concurrent run spent an attempt after this one claimed: the row says
    // this was the last.
    scriptedClient({ queue: [OPERATION(0)], failOn: /status = 'succeeded'/ });
    db.query.mockResolvedValueOnce({ rows: [{ status: "failed" }], rowCount: 1 });

    expect(await processAccountErasures()).toEqual({ erased: 0, refused: 0, retrying: 0, failed: 1 });
  });

  it("still ends the run cleanly when recording the attempt fails too", async () => {
    scriptedClient({ queue: [OPERATION(0)], failOn: /status = 'succeeded'/ });
    db.query.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(processAccountErasures()).resolves.toEqual({ erased: 0, refused: 0, retrying: 1, failed: 0 });
  });
});

describe("the photo an account uploaded through our card (#474)", () => {
  // A block, not an expression: a function returned from beforeEach is run as its teardown.
  beforeEach(() => {
    store.deleteUploadedPhoto.mockReset().mockResolvedValue(undefined);
  });

  it("is deleted with the account", async () => {
    scriptedClient({ queue: [OPERATION()] });
    expect(await processAccountErasures()).toEqual({ erased: 1, refused: 0, retrying: 0, failed: 0 });
    expect(store.deleteUploadedPhoto).toHaveBeenCalledWith("auth0|gone");
  });

  it("is deleted only once the erasure has committed, outside its transaction", async () => {
    const events: string[] = [];
    const client = scriptedClient({ queue: [OPERATION()] });
    db.transaction.mockImplementation(async (callback: (c: typeof client) => Promise<unknown>) => {
      events.push("begin");
      const result = await callback(client);
      events.push("commit");
      return result;
    });
    store.deleteUploadedPhoto.mockImplementation(async () => {
      events.push("delete");
    });
    await processAccountErasures();
    expect(events.filter((event) => event === "delete")).toHaveLength(1);
    expect(events.at(-1)).toBe("delete");
    expect(events.lastIndexOf("commit")).toBeLessThan(events.indexOf("delete"));
  });

  it("does not hold up the erasure when it cannot be deleted, since it expires in minutes", async () => {
    store.deleteUploadedPhoto.mockRejectedValue(new Error("bucket unreachable"));
    scriptedClient({ queue: [OPERATION()] });
    expect(await processAccountErasures()).toEqual({ erased: 1, refused: 0, retrying: 0, failed: 0 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("account_erasure.uploaded_photo_delete_failed"));
  });

  it("leaves no timer running once the photo is deleted, so the run can exit", async () => {
    vi.useFakeTimers();
    try {
      scriptedClient({ queue: [OPERATION()] });
      await processAccountErasures();
      expect(store.deleteUploadedPhoto).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves on after ten seconds when the store does not answer", async () => {
    vi.useFakeTimers();
    try {
      store.deleteUploadedPhoto.mockImplementation(() => new Promise<undefined>(() => undefined));
      scriptedClient({ queue: [OPERATION()] });
      let settled = false;
      const run = processAccountErasures().finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(UPLOADED_PHOTO_DELETE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(run).resolves.toEqual({ erased: 1, refused: 0, retrying: 0, failed: 0 });
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"errorClass":"ETIMEDOUT"'));
    } finally {
      vi.useRealTimers();
    }
  });

  it("is left alone when the erasure is refused", async () => {
    scriptedClient({ queue: [OPERATION()], blockers: { orders_in_flight: 1 } });
    await processAccountErasures();
    expect(store.deleteUploadedPhoto).not.toHaveBeenCalled();
  });
});

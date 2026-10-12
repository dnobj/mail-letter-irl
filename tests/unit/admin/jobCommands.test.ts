import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sending held mail now (#535): the panel's job.dispatch_now command, the
 * job page's form that leads to it, and the rule both read. The service it
 * calls is proven in tests/unit/services/letterJobService.test.ts and, with
 * the operator role's grants and migration 042, in
 * tests/integration/adminCommands.postgres.test.ts.
 */

const mocks = vi.hoisted(() => ({ release: vi.fn(), cancel: vi.fn() }));
vi.mock("../../../src/services/letterJobService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/services/letterJobService.js")>()),
  releaseHeldLetterJobAsAdmin: mocks.release,
  cancelLeftLetterJobAsAdmin: mocks.cancel,
}));

import { findAdminCommand } from "../../../src/admin/commands/index.js";
import { jobCancelHeldCommand, jobDispatchNowCommand, jobResolveCommand } from "../../../src/admin/commands/jobs.js";
import type { AdminSqlClient } from "../../../src/admin/database.js";
import { renderLetter } from "../../../src/admin/pages/accounts.js";
import { jobActionPanel } from "../../../src/admin/pages/commands.js";
import { renderJobDetail } from "../../../src/admin/pages/operations.js";
import { html } from "../../../src/admin/ui/html.js";
import { isFundingHeldMailJob, isHeldMailJob, listAttentionJobs, readJob, type JobView } from "../../../src/admin/queries/jobs.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE = new Date(Date.now() + 5 * DAY_MS);
const UPDATED = new Date("2026-10-01T10:00:00.000Z");

/** A held letter's job as readJob reads it: pending, never attempted, due in five days. */
const HELD_ROW: Record<string, unknown> = {
  job_id: "job-held",
  status: "pending",
  provider_outcome: "not_dispatched",
  attempts: 0,
  max_attempts: 5,
  scheduled_at: RELEASE,
  next_attempt_at: RELEASE,
  locked_at: null,
  has_provider_order_id: false,
  provider_dispatch_started_at: null,
  held_at: null,
  hold_reason: null,
  operator_resolution: null,
  resolved_at: null,
  last_error: null,
  created_at: UPDATED,
  updated_at: UPDATED,
  held_until: RELEASE.toISOString(),
  letter_id: "letter-1",
  user_id: "auth0|u1",
  letter_status: "queued",
  mail_type: "letter",
  funding_type: "prepaid_balance",
  funding_order_id: null,
};

function client(row: Record<string, unknown> | null): AdminSqlClient {
  return { query: vi.fn(async () => ({ rows: row ? [row] : [] })) } as unknown as AdminSqlClient;
}

async function jobView(overrides: Record<string, unknown> = {}): Promise<JobView> {
  return (await readJob(client({ ...HELD_ROW, ...overrides }), "job-held"))!;
}

function execution(reason = "customer asked to send it now") {
  return {
    commandId: "run-1",
    idempotencyKey: "admin:run-1",
    actorId: "owner@example.com",
    environment: "development" as const,
    reason,
    client: null,
  };
}

const NOT_HELD: Array<[string, Record<string, unknown>]> = [
  ["taken by the outbox", { status: "processing" }],
  ["dispatched", { provider_outcome: "dispatching" }],
  ["attempted", { attempts: 1 }],
  ["no longer queued", { letter_status: "cancelled" }],
  ["resolved by an operator", { operator_resolution: "account_erased" }],
  ["not held mail at all", { held_until: null }],
  ["holding something that is not a time", { held_until: "soon" }],
  ["due already", { next_attempt_at: new Date(Date.now() - 60_000) }],
];

beforeEach(() => {
  mocks.release.mockReset();
  mocks.release.mockResolvedValue({ jobId: "job-held", replayed: false });
  mocks.cancel.mockReset();
  mocks.cancel.mockResolvedValue({ jobId: "job-held", replayed: false });
});

describe("job.resolve (#625)", () => {
  const AMBIGUOUS = { ...HELD_ROW, status: "held", provider_outcome: "ambiguous", letter_status: "held" };
  const WARNING = "Manual fulfilment cannot send certified mail: accepting a certified letter with this provider is refused.";
  const preview = (decision: string, providerName: string) =>
    jobResolveCommand.preview(
      client(AMBIGUOUS),
      "job-held",
      jobResolveCommand.parseInput(
        new Map([
          ["decision", decision],
          ["providerName", providerName],
          ...(decision === "accepted" ? [["providerTrackingId", "provider-ref-001"] as [string, string]] : [])
        ]) as never
      )
    );

  it("warns when manual fulfilment is named to accept a letter: it cannot send certified mail", async () => {
    expect((await preview("accepted", "diy")).warnings).toContain(WARNING);
  });

  it.each(["postgrid", "dummy"])("does not warn for %s, which sells it", async providerName => {
    expect((await preview("accepted", providerName)).warnings).not.toContain(WARNING);
  });

  it.each(["retry", "rejected"])("does not warn for %s, which manual fulfilment may be named for", async decision => {
    expect((await preview(decision, "diy")).warnings).not.toContain(WARNING);
  });

  const DRAWN = "This provider does not print what our renderer drew: accepting a letter previewed on our renderer (all mail while LETTER_IRL_PRINT_RENDERER=pdf) is refused.";

  it("warns when manual fulfilment is named to accept a letter: it does not print what our renderer drew (#698)", async () => {
    expect((await preview("accepted", "diy")).warnings).toContain(DRAWN);
  });

  it.each(["postgrid", "dummy"])("does not warn of the renderer for %s, which prints it (#698)", async providerName => {
    expect((await preview("accepted", providerName)).warnings).not.toContain(DRAWN);
  });
});

describe("job.dispatch_now (#535)", () => {
  it("is registered, and confirms with its own verb outside a panel transaction", () => {
    expect(findAdminCommand("job.dispatch_now")).toBe(jobDispatchNowCommand);
    expect(jobDispatchNowCommand.action).toBe("job.dispatch_now");
    expect(jobDispatchNowCommand.targetType).toBe("letter_job");
    expect(jobDispatchNowCommand.verb({})).toBe("DISPATCH");
    expect(jobDispatchNowCommand.transactional).toBe(false);
  });

  it("previews held mail: the letter, the account, how it was paid for and when it was due", async () => {
    const preview = await jobDispatchNowCommand.preview(client(HELD_ROW), "job-held", {});
    expect(preview.targetId).toBe("job-held");
    expect(preview.summary).toEqual({
      letterId: "letter-1",
      userId: "auth0|u1",
      fundingOrderId: null,
      heldUntil: RELEASE.toISOString(),
      jobStatus: "pending",
    });
    expect(preview.expectedVersion).toBe(UPDATED.toISOString());
    expect(preview.display).toEqual([
      ["Job", "job-held"],
      ["Letter", "letter-1"],
      ["Account", "auth0|u1"],
      ["Funding", "prepaid balance"],
      ["Held until", `${RELEASE.toISOString()} (09:00 New York time on its mail date)`],
    ]);
    expect(preview.warnings[0]).toMatch(/^The letter goes to the printer at the next hourly maintenance run instead of on its mail date/);
    expect(preview.warnings).toContain("The customer can still cancel it until that run takes it.");
  });

  it("names a gift letter's funding in words", async () => {
    const preview = await jobDispatchNowCommand.preview(client({ ...HELD_ROW, funding_type: "gift_letter" }), "job-held", {});
    expect(preview.display).toContainEqual(["Funding", "a gift letter"]);
  });

  it("names a Pay & Send letter's order", async () => {
    const preview = await jobDispatchNowCommand.preview(
      client({ ...HELD_ROW, funding_type: "jit_order", funding_order_id: "order-1" }),
      "job-held",
      {},
    );
    expect(preview.display).toContainEqual(["Funding", "Pay & Send order order-1"]);
    expect(preview.summary).toMatchObject({ fundingOrderId: "order-1" });
  });

  it("refuses a missing job, and any job that is not held mail", async () => {
    await expect(jobDispatchNowCommand.preview(client(null), "job-none", {})).rejects.toMatchObject({ code: "ADMIN_NOT_FOUND" });
    for (const [label, overrides] of NOT_HELD) {
      await expect(jobDispatchNowCommand.preview(client({ ...HELD_ROW, ...overrides }), "job-held", {}), label).rejects.toMatchObject({
        code: "ADMIN_INVALID_STATE",
      });
    }
  });

  it("asks the service to release it for the previewed account, with the operator, the reason and the run's key", async () => {
    const preview = await jobDispatchNowCommand.preview(client(HELD_ROW), "job-held", {});
    await expect(jobDispatchNowCommand.execute(execution(), "job-held", {}, preview)).resolves.toEqual({
      jobStatus: "pending",
      domainReplayed: false,
    });
    expect(mocks.release).toHaveBeenCalledWith({
      jobId: "job-held",
      expectedUserId: "auth0|u1",
      actorId: "owner@example.com",
      reason: "customer asked to send it now",
      idempotencyKey: "admin:run-1",
    });

    mocks.release.mockResolvedValueOnce({ jobId: "job-held", replayed: true });
    await expect(jobDispatchNowCommand.execute(execution(), "job-held", {}, preview)).resolves.toMatchObject({ domainReplayed: true });
  });

  it("refuses a reason too short or too long without calling the service", async () => {
    const preview = await jobDispatchNowCommand.preview(client(HELD_ROW), "job-held", {});
    for (const reason of ["send it", "x".repeat(501)]) {
      await expect(jobDispatchNowCommand.execute(execution(reason), "job-held", {}, preview)).rejects.toMatchObject({
        code: "ADMIN_INVALID_REQUEST",
      });
    }
    expect(mocks.release).not.toHaveBeenCalled();
    // The bounds themselves are allowed.
    await jobDispatchNowCommand.execute(execution("x".repeat(8)), "job-held", {}, preview);
    await jobDispatchNowCommand.execute(execution("x".repeat(500)), "job-held", {}, preview);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("passes on the service's refusals as the panel's codes", async () => {
    const preview = await jobDispatchNowCommand.preview(client(HELD_ROW), "job-held", {});
    for (const [code, adminCode] of [
      ["invalid_state", "ADMIN_INVALID_STATE"],
      ["not_found", "ADMIN_NOT_FOUND"],
      ["idempotency_conflict", "ADMIN_IDEMPOTENCY_CONFLICT"],
    ]) {
      mocks.release.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await expect(jobDispatchNowCommand.execute(execution(), "job-held", {}, preview), code).rejects.toMatchObject({ code: adminCode });
    }
  });
});

describe("held mail on the job page (#535)", () => {
  it("reads the job's hold, and calls it held only while it is not yet due", async () => {
    const reader = client(HELD_ROW);
    await readJob(reader, "job-held");
    // From the job's own column (055, #693), which the reader role reads with the job; never letters.mail_on.
    const [text] = (reader.query as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0];
    expect(text).toContain("j.mail_hold_until AS held_until");
    expect(text).not.toContain("heldUntil");
    expect(text).not.toContain("mail_on");

    const held = await jobView();
    expect(held.heldUntil).toEqual(RELEASE);
    expect(isHeldMailJob(held)).toBe(true);
    // The clock decides: the same job at its release is due.
    expect(isHeldMailJob(held, RELEASE.getTime())).toBe(false);
    expect(isHeldMailJob(held, RELEASE.getTime() - 1)).toBe(true);
    for (const [label, overrides] of NOT_HELD) {
      expect(isHeldMailJob(await jobView(overrides)), label).toBe(false);
    }
    expect((await jobView({ held_until: "soon" })).heldUntil).toBeNull();
  });

  it("offers sending held mail now only for held mail", async () => {
    const form = String(jobActionPanel({ job: await jobView(), mode: "full" }));
    expect(form).toContain('action="/commands/job.dispatch_now/preview"');
    expect(form).toContain('name="target" value="job-held"');
    expect(form).not.toContain("Read-only mode");

    for (const [label, overrides] of NOT_HELD) {
      expect(String(jobActionPanel({ job: await jobView(overrides), mode: "full" })), label).not.toContain("job.dispatch_now");
    }
    // A failed job still offers its retry, and nothing else.
    const failed = String(
      jobActionPanel({
        job: await jobView({ status: "failed", provider_outcome: "definite_failure", attempts: 5, letter_status: "failed" }),
        mode: "full",
      }),
    );
    expect(failed).toContain("/commands/job.retry/preview");
    expect(failed).not.toContain("job.dispatch_now");
  });

  it("still offers an ambiguous job its resolution, and nothing else", async () => {
    const form = String(
      jobActionPanel({
        job: await jobView({ status: "held", provider_outcome: "ambiguous", attempts: 1, letter_status: "held" }),
        mode: "full",
      }),
    );
    expect(form).toContain("Resolve with provider evidence");
    expect(form).toContain('action="/commands/job.resolve/preview"');
    expect(form).toContain('name="target" value="job-held"');
    expect(form).not.toContain("job.dispatch_now");
    expect(form).not.toContain("job.retry");
  });

  it("shows the hold on the job page and the letter page, and a dash for any other job", async () => {
    const stamp = `datetime="${RELEASE.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z")}"`;
    const held = await jobView();
    const jobPage = String(renderJobDetail({ job: held, actions: html`` }));
    expect(jobPage).toContain(`<dt>held for its mail date until</dt><dd><time ${stamp}`);

    const letterPage = String(
      renderLetter({
        detail: { letter: { letterId: "letter-1", status: "queued" }, userId: "auth0|u1", history: [], job: held, savedCopy: null } as never,
      }),
    );
    expect(letterPage).toContain(`<dt>held for its mail date until</dt><dd><time ${stamp}`);

    const ordinary = String(renderJobDetail({ job: await jobView({ held_until: null }), actions: html`` }));
    expect(ordinary).toContain('<dt>held for its mail date until</dt><dd><span class="muted">—</span></dd>');
  });

  it("says execution is refused in read-only mode", async () => {
    expect(String(jobActionPanel({ job: await jobView(), mode: "read-only" }))).toContain("Read-only mode");
  });
});

describe("job.dispatch_now for mail held for its funding (#696)", () => {
  /** A pack's letter held because the pack was refunded: pending, never attempted, due already, no mail date. */
  const FUNDING_HELD = {
    ...HELD_ROW,
    hold_reason: "funding_reversed",
    held_until: null,
    next_attempt_at: new Date(Date.now() - DAY_MS),
  };

  it("previews it, due or not, saying why it is held and what releasing it means", async () => {
    const preview = await jobDispatchNowCommand.preview(client(FUNDING_HELD), "job-held", {});
    expect(preview.summary).toEqual({
      letterId: "letter-1",
      userId: "auth0|u1",
      fundingOrderId: null,
      heldUntil: null,
      jobStatus: "pending",
      fundingHold: "funding_reversed",
    });
    expect(preview.display).toContainEqual(["Held because", "the pack that paid for it was refunded in full"]);
    expect(preview.display.some(([label]) => label === "Held until")).toBe(false);
    expect(preview.warnings[0]).toMatch(/^The money that paid for this letter went back, or may\./);
    expect(preview.warnings).toContain("If the account's sending is blocked, the letter still waits until it is unblocked.");

    const disputed = await jobDispatchNowCommand.preview(client({ ...FUNDING_HELD, hold_reason: "funding_disputed" }), "job-held", {});
    expect(disputed.display).toContainEqual(["Held because", "the pack that paid for it is disputed"]);
  });

  it("previews held mail before its date with no funding warning", async () => {
    const preview = await jobDispatchNowCommand.preview(client(HELD_ROW), "job-held", {});
    expect(preview.warnings.some(warning => warning.startsWith("The money that paid"))).toBe(false);
    expect(preview.summary).not.toHaveProperty("fundingHold");
  });

  it.each([
    ["taken by the outbox", { status: "processing" }],
    ["dispatched", { provider_outcome: "dispatching" }],
    ["out of attempts", { attempts: 5 }],
    ["no longer queued", { letter_status: "cancelled" }],
    ["resolved by an operator", { operator_resolution: "account_erased" }],
    ["held for another reason", { hold_reason: "provider_outcome_ambiguous" }],
  ])("refuses mail held for its funding that is %s", async (_label, overrides) => {
    await expect(jobDispatchNowCommand.preview(client({ ...FUNDING_HELD, ...overrides }), "job-held", {})).rejects.toMatchObject({
      code: "ADMIN_INVALID_STATE",
    });
  });

  it("is told apart from held mail", async () => {
    const funding = await jobView(FUNDING_HELD);
    expect(isFundingHeldMailJob(funding)).toBe(true);
    expect(isHeldMailJob(funding)).toBe(false);
    const held = await jobView();
    expect(isFundingHeldMailJob(held)).toBe(false);
  });

  it("is offered on the job's page, saying why it waits", async () => {
    const panel = String(jobActionPanel({ job: await jobView(FUNDING_HELD), mode: "full" }));
    expect(panel).toContain("<h2>Left for the operator</h2>");
    expect(panel).toContain("refunded in full");
    expect(panel).toContain('action="/commands/job.dispatch_now/preview"');
    const disputed = String(jobActionPanel({ job: await jobView({ ...FUNDING_HELD, hold_reason: "funding_disputed" }), mode: "full" }));
    expect(disputed).toContain("letter was disputed, so it waits");
  });

  it("is listed among the jobs that need an operator", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await listAttentionJobs({ query } as unknown as AdminSqlClient, 50);
    const sql = String((query.mock.calls[0] as unknown[])[0]).replace(/\s+/g, " ");
    expect(sql).toContain(
      "OR (j.status = 'pending' AND (j.provider_outcome = 'not_dispatched' AND j.hold_reason IS NOT NULL AND j.hold_reason IN ('funding_reversed', 'funding_disputed')))"
    );
    // And a blocked account's mail, which nothing else lists.
    expect(sql).toContain("OR (j.status = 'pending' AND j.provider_outcome = 'not_dispatched' AND u.sends_blocked_reason IS NOT NULL)");
  });
});

describe("job.cancel_held: mail left for the operator (#696)", () => {
  const LEFT = { ...HELD_ROW, hold_reason: "funding_disputed", held_until: null, next_attempt_at: new Date(Date.now() - DAY_MS) };
  const BLOCKED = { ...HELD_ROW, hold_reason: null, held_until: null, next_attempt_at: new Date(Date.now() - DAY_MS), account_blocked: true };

  it("is registered, and confirms with its own verb outside a panel transaction", () => {
    expect(findAdminCommand("job.cancel_held")).toBe(jobCancelHeldCommand);
    expect(jobCancelHeldCommand.targetType).toBe("letter_job");
    expect(jobCancelHeldCommand.verb({})).toBe("CANCEL");
    expect(jobCancelHeldCommand.transactional).toBe(false);
  });

  it("previews mail held for its funding, or of a blocked account, saying why and what goes back", async () => {
    const preview = await jobCancelHeldCommand.preview(client(LEFT), "job-held", {});
    expect(preview.summary).toEqual({ letterId: "letter-1", userId: "auth0|u1", fundingType: "prepaid_balance", jobStatus: "pending" });
    expect(preview.display).toContainEqual(["Held because", "the pack that paid for it is disputed"]);
    expect(preview.warnings).toContain("The letter is cancelled and never printed.");
    const blocked = await jobCancelHeldCommand.preview(client(BLOCKED), "job-held", {});
    expect(blocked.display).toContainEqual(["Held because", "the account's sending is blocked"]);
  });

  it.each([
    ["not left for the operator", { hold_reason: null }],
    ["Pay & Send", { funding_type: "jit_order", funding_order_id: "order-1" }],
    // Each mark of Pay & Send refuses on its own.
    ["tied to an order", { funding_order_id: "order-1" }],
    ["funded by an order", { funding_type: "jit_order" }],
    ["out of attempts", { attempts: 5 }],
    ["no longer queued", { letter_status: "cancelled" }],
  ])("refuses mail that is %s", async (_label, overrides) => {
    await expect(jobCancelHeldCommand.preview(client({ ...LEFT, ...overrides }), "job-held", {})).rejects.toMatchObject({
      code: "ADMIN_INVALID_STATE",
    });
  });

  it("asks the service to cancel it for the previewed account, with the operator, the reason and the run's key", async () => {
    const preview = await jobCancelHeldCommand.preview(client(LEFT), "job-held", {});
    await expect(jobCancelHeldCommand.execute(execution("the dispute was lost for good"), "job-held", {}, preview)).resolves.toEqual({
      jobStatus: "cancelled",
      domainReplayed: false,
    });
    expect(mocks.cancel).toHaveBeenCalledWith({
      jobId: "job-held",
      expectedUserId: "auth0|u1",
      actorId: "owner@example.com",
      reason: "the dispute was lost for good",
      idempotencyKey: "admin:run-1",
    });
    await expect(jobCancelHeldCommand.execute(execution("short"), "job-held", {}, preview)).rejects.toMatchObject({
      code: "ADMIN_INVALID_REQUEST",
    });
  });

  it("is offered on the page with the release for a funding hold, and alone for a blocked account", async () => {
    const funding = String(jobActionPanel({ job: await jobView(LEFT), mode: "full" }));
    expect(funding).toContain('action="/commands/job.dispatch_now/preview"');
    expect(funding).toContain('action="/commands/job.cancel_held/preview"');
    const blocked = String(jobActionPanel({ job: await jobView(BLOCKED), mode: "full" }));
    expect(blocked).toContain("sending is blocked, so this letter waits here");
    expect(blocked).not.toContain("job.dispatch_now");
    expect(blocked).toContain('action="/commands/job.cancel_held/preview"');
    const paid = String(jobActionPanel({ job: await jobView({ ...BLOCKED, funding_type: "jit_order", funding_order_id: "order-1" }), mode: "full" }));
    expect(paid).not.toContain("job.cancel_held");
    expect(paid).toContain("cancelled by refunding its order");
  });
});

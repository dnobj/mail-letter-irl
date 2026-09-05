/**
 * Three silent failures that reached the first real production account.
 *
 * A brand-new account had no `users` row, because provisioning is skipped
 * whenever no verified email is available and nothing retries it. One absent
 * row then produced three unrelated-looking symptoms:
 *
 *   get_account_balance      -> "0"        (a SELECT finding no row)
 *   set_return_address       -> "Saved!"   (an UPDATE matching no row)
 *   quote_and_preview_letter -> "database error"
 *                               (letter_drafts.user_id -> users(user_id))
 *
 * None of them said "your account does not exist". The middle one actively
 * lied, and the log line that would have explained all three was both
 * mis-levelled and invisible to the log viewer. These tests pin the three
 * fixes, because every one of them is the kind that regresses without notice.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { classifyDiagnosticError, writeDiagnostic } from "../../../src/utils/diagnosticLog.js";

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/db/index.js", () => ({ query: queryMock }));

describe("a return-address save that matched no row", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("reports failure instead of success", async () => {
    // THE DEFECT. saveReturnAddress returned void and never read rowCount, so
    // an UPDATE against a non-existent user_id was indistinguishable from a
    // real write - all the way out to "Return address saved successfully",
    // which is what production logged microseconds before the next tool
    // answered "No return address provided".
    const { setReturnAddress } = await import("../../../src/services/returnAddressService.js");
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await setReturnAddress("user-with-no-account", {
      name: "Test Person",
      addressLine1: "1600 Pennsylvania Ave NW",
      city: "Washington",
      state: "DC",
      postalCode: "20500",
      country: "US"
    });

    expect(result.success).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/account/i);
  });

  it("still succeeds when a row was actually updated", async () => {
    // Guards the check above against being satisfied by always failing.
    const { setReturnAddress } = await import("../../../src/services/returnAddressService.js");
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await setReturnAddress("user-with-an-account", {
      name: "Test Person",
      addressLine1: "1600 Pennsylvania Ave NW",
      city: "Washington",
      state: "DC",
      postalCode: "20500",
      country: "US"
    });

    expect(result.success).toBe(true);
  });
});

describe("diagnostics a log viewer can actually show", () => {
  let logged: string[];
  let spies: Array<{ mockRestore: () => void }>;

  beforeEach(() => {
    logged = [];
    const capture = (value: unknown) => {
      logged.push(String(value));
    };
    spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture)
    ];
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
  });

  it("carries a message field, not only structured fields", () => {
    // THE DEFECT. The payload was `{...fields, event}` with no message, so
    // Railway - which renders a JSON line by its message field, pino-style -
    // displayed nothing at all. Every diagnostic in the system was invisible
    // in production while the pino logger's lines beside them came through,
    // and a log search for the event name returned silence indistinguishable
    // from the event never firing.
    writeDiagnostic("error", "auth.account_missing_no_verified_email", {
      reason: "verified_email_unavailable"
    });

    expect(logged).toHaveLength(1);
    const payload = JSON.parse(logged[0]) as Record<string, unknown>;
    expect(payload.msg).toBe("auth.account_missing_no_verified_email");
    expect(payload.event).toBe("auth.account_missing_no_verified_email");
    expect(payload.reason).toBe("verified_email_unavailable");
  });

  it("does not let a caller field displace the event name", () => {
    writeDiagnostic("info", "some.event", { msg: "attacker-supplied" } as never);
    const payload = JSON.parse(logged[0]) as Record<string, unknown>;
    expect(payload.msg).toBe("some.event");
  });
});

describe("foreign-key violations are named, not collapsed", () => {
  it("surfaces 23503 rather than a generic category", () => {
    // letter_drafts.user_id REFERENCES users(user_id) is the only place a
    // missing account announces itself, and 23503 was absent from the
    // allowlist while its siblings 23505 and 23514 were present - so the
    // customer got "database error", the mislabel #213 was filed about.
    expect(classifyDiagnosticError({ code: "23503" }, "database_error")).toBe("23503");
  });

  it("still collapses codes that are not on the allowlist", () => {
    // The allowlist exists to keep unvetted driver text out of the logs;
    // widening it must not become "pass anything through".
    expect(classifyDiagnosticError({ code: "some_internal_detail" }, "database_error")).toBe(
      "database_error"
    );
  });
});

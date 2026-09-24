import { describe, expect, it, vi } from "vitest";

import type { AdminSqlClient } from "../../../src/admin/database.js";
import { renderLetter } from "../../../src/admin/pages/accounts.js";
import { renderRetention } from "../../../src/admin/pages/ops.js";
import type { LetterDetail } from "../../../src/admin/queries/accounts.js";
import { listQuarantine, listRecentRestores, type RestoreOperationView } from "../../../src/admin/queries/ops.js";

/**
 * Where a restore starts and where its outcome shows (#450 review): the
 * Retention page's search and its recent restores, and the saved copy on a
 * letter's own page. Metadata, codes and reasons only. The PostgreSQL suite
 * runs the same queries through the reader role.
 */

const COPY = "8f14e45f-ceea-467a-9575-9c2d1f7c0a11";
const USER = "auth0|restore-user";
const AT = new Date("2026-09-20T03:00:00.000Z");
const PURGE = new Date("2026-09-27T03:00:00.000Z");

const COUNTS = { lettersRedacted: 1, draftsRedacted: 0, quarantinedLetters: 1, quarantinedDrafts: 0, purgeDueNow: 0 };

function retentionPage(input: Partial<Parameters<typeof renderRetention>[0]> = {}): string {
  return String(
    renderRetention({
      counts: COUNTS,
      quarantine: [],
      restores: [],
      search: null,
      report: null,
      reportError: null,
      ...input,
    }),
  );
}

const restore = (status: string, extra: Partial<RestoreOperationView> = {}): RestoreOperationView => ({
  operationId: "op-1",
  status,
  sourceTable: "letters",
  sourceId: "letter_1",
  requestedAt: AT,
  completedAt: status === "pending" ? null : PURGE,
  errorCode: null,
  result: null,
  ...extra,
});

describe("the Retention page", () => {
  it("lists each copy with its account and a restore, and offers a search", () => {
    const page = retentionPage({
      quarantine: [
        { quarantineId: COPY, sourceTable: "letters", sourceId: "letter_1", userId: USER, quarantinedAt: AT, purgeAfter: PURGE },
      ],
    });
    expect(page).toContain('action="/retention"');
    expect(page).toContain("The newest 100 copies. Search to find an older one.");
    expect(page).toContain(`href="/accounts/${encodeURIComponent(USER)}"`);
    expect(page).toContain('href="/letters/letter_1"');
    expect(page).toContain(`name="target" value="${COPY}"`);
    expect(page).toContain('action="/commands/retention.restore/preview"');
  });

  it("says what it searched for, keeps the term, and offers the way back", () => {
    const page = retentionPage({ search: USER });
    expect(page).toContain(`value="${USER}"`);
    expect(page).toContain("Copies matching");
    expect(page).toContain('<a href="/retention">Show the newest</a>');
    expect(page).toContain("no copy matches.");
  });

  it("escapes the search term", () => {
    const page = retentionPage({ search: '"><script>x</script>' });
    expect(page).not.toContain("<script>x</script>");
  });

  it("shows how each recent restore ended, in words", () => {
    const page = retentionPage({
      restores: [
        restore("pending"),
        restore("succeeded", { result: { sourceTable: "letters" } }),
        restore("succeeded", { result: { alreadyRestored: true } }),
        restore("failed", { errorCode: "RETENTION_RESTORE_UNAVAILABLE", result: { reason: "window_closed" } }),
        restore("failed", { errorCode: "RETENTION_RESTORE_UNAVAILABLE", result: { reason: "not_redacted" } }),
        restore("failed", { errorCode: "RETENTION_RESTORE_ERROR", result: { errorClass: "database_error" } }),
      ],
    });
    expect(page).toContain("<h2>Recent restores</h2>");
    expect(page).toContain(">queued<");
    expect(page).toContain(">restored<");
    expect(page).toContain("restored by an earlier request");
    expect(page).toContain("RETENTION_RESTORE_UNAVAILABLE</span>: the copy was purged before the run");
    expect(page).toContain("RETENTION_RESTORE_UNAVAILABLE</span>: the content was already live");
    expect(page).toContain("RETENTION_RESTORE_ERROR</span>: database_error");
  });

  it("says when nothing has been restored yet", () => {
    expect(retentionPage()).toContain("none yet.");
  });
});

describe("a letter's saved copy", () => {
  function letterPage(redactedAt: Date | null, savedCopy: LetterDetail["savedCopy"]): string {
    const detail: LetterDetail = {
      letter: {
        letterId: "letter_1",
        status: "delivered",
        mailType: "letter",
        fundingType: "credits",
        fundingOrderId: null,
        creditsCost: 2,
        provider: "postgrid",
        hasTrackingId: true,
        createdAt: AT,
        sentAt: AT,
        statusUpdatedAt: AT,
        redactedAt,
        jobId: null,
        jobStatus: null,
        jobProviderOutcome: null,
        jobHoldReason: null,
      },
      userId: USER,
      history: [],
      job: null,
      savedCopy,
    };
    return String(renderLetter({ detail }));
  }

  it("offers the restore on a redacted letter while its copy is kept", () => {
    const page = letterPage(AT, { quarantineId: COPY, purgeAfter: PURGE });
    expect(page).toContain("saved copy");
    expect(page).toContain("in quarantine, purged");
    expect(page).toContain(`name="target" value="${COPY}"`);
    expect(page).toContain('action="/commands/retention.restore/preview"');
  });

  it("says there is nothing left once the copy is gone", () => {
    const page = letterPage(AT, null);
    expect(page).toContain("none left");
    expect(page).not.toContain("retention.restore/preview");
  });

  it("says nothing about a copy for a letter that was never redacted", () => {
    const page = letterPage(null, null);
    expect(page).not.toContain("saved copy");
  });
});

describe("the queries behind them", () => {
  function scripted() {
    const query = vi.fn(async () => ({ rows: [] }));
    return { client: { query } as unknown as AdminSqlClient, query };
  }

  it("finds copies by their own id or by the account the letter or draft belongs to", async () => {
    const { client, query } = scripted();
    await listQuarantine(client, 100, USER);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual([100, USER]);
    const text = sql.replace(/\s+/g, " ");
    expect(text).toContain("q.source_id = $2::varchar");
    expect(text).toContain("l.user_id = $2::varchar");
    expect(text).toContain("d.user_id = $2::varchar");
    expect(text).toContain("ORDER BY q.quarantined_at DESC LIMIT $1::int");
  });

  it("lists the newest copies when there is no search", async () => {
    const { client, query } = scripted();
    await listQuarantine(client, 100);
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual([100, null]);
  });

  it("reads only restore operations, newest first", async () => {
    const { client, query } = scripted();
    await listRecentRestores(client, 20);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["retention.restore", 20]);
    const text = sql.replace(/\s+/g, " ");
    expect(text).toContain("JOIN admin_command_runs r ON r.id = o.command_id");
    expect(text).toContain("ORDER BY r.requested_at DESC");
  });
});

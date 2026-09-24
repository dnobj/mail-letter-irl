import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { accountErasurePanel } from "../../../src/admin/pages/accountActions.js";

/**
 * The erasure panel on the account page (#289): what it offers, and what it
 * says about each state of the newest erasure. Counts and codes only.
 */

const USER = "auth0|panel-user";
const REQUESTED = new Date("2026-09-23T10:00:00Z");
const COMPLETED = new Date("2026-09-23T11:00:00Z");

function render(input: Partial<Parameters<typeof accountErasurePanel>[0]>): string {
  return String(accountErasurePanel({ userId: USER, erased: false, erasure: null, mode: "full", ...input }));
}

const operation = (status: string, extra: Record<string, unknown> = {}) => ({
  operationId: "op-1",
  status,
  attempts: 0,
  requestedAt: REQUESTED,
  completedAt: status === "pending" ? null : COMPLETED,
  errorCode: null,
  result: null,
  ...extra,
});

describe("the erasure panel", () => {
  it("offers the preview for an account with no erasure", () => {
    const page = render({});
    expect(page).toContain('action="/commands/account.erase/preview"');
    expect(page).toContain(`value="${USER}"`);
  });

  it("says a queued erasure is waiting, and offers nothing", () => {
    const page = render({ erasure: operation("pending", { attempts: 2 }) });
    expect(page).toContain("Erasure queued");
    expect(page).toContain("2 attempts so far");
    expect(page).not.toContain("account.erase/preview");
  });

  it("shows an erased account's counts and no form", () => {
    const page = render({
      erased: true,
      erasure: operation("succeeded", { result: { lettersScrubbed: 3, accessTokensDeleted: 1 } }),
    });
    expect(page).toContain("Erased");
    expect(page).toContain("lettersScrubbed");
    expect(page).not.toContain("account.erase/preview");
  });

  it("says the counts are on the earlier erasure when the newest found nothing left to do", () => {
    const page = render({ erased: true, erasure: operation("succeeded", { result: { alreadyErased: true } }) });
    expect(page).toContain("already erased");
    expect(page).not.toContain("alreadyErased");
  });

  it("names why the last erasure did not run, and offers it again", () => {
    const page = render({
      erasure: operation("failed", { errorCode: "ACCOUNT_ERASURE_BLOCKED", result: { ordersInFlight: 1 } }),
    });
    expect(page).toContain("ACCOUNT_ERASURE_BLOCKED");
    expect(page).toContain("ordersInFlight");
    expect(page).toContain("account.erase/preview");
  });

  it("escapes what it prints", () => {
    const page = render({
      erasure: operation("failed", { errorCode: "<b>x</b>", result: { note: "<script>" } }),
    });
    expect(page).not.toContain("<b>x</b>");
    expect(page).not.toContain("<script>");
  });
});

describe("which MCP transport decides the account on every call (#446 review)", () => {
  const httpServer = readFileSync(join(process.cwd(), "src/mcp/httpServer.ts"), "utf8");

  it("rechecks on the legacy SSE stream, whose one server outlives any single call, and only there", () => {
    const calls = httpServer.match(/createMcpServer\(letterServer, authInfo(?:, \{[^}]*\})?\)/g) ?? [];
    expect(calls).toEqual([
      "createMcpServer(letterServer, authInfo, { recheckAccountPerCall: true })",
      "createMcpServer(letterServer, authInfo)",
    ]);
    // The first is the SSE session's server.
    expect(httpServer).toMatch(
      /createMcpServer\(letterServer, authInfo, \{ recheckAccountPerCall: true \}\);\s*\n\s*\n\s*const sseTransport = new SSEServerTransport/
    );
  });
});

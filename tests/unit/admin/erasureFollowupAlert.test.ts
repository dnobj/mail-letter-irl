import { describe, expect, it } from "vitest";

import { alertActionPanel } from "../../../src/admin/pages/commands.js";
import { alertSubjectLink, renderAlertDetail } from "../../../src/admin/pages/operations.js";
import type { AlertView } from "../../../src/admin/queries/alerts.js";
import { html } from "../../../src/admin/ui/html.js";

/**
 * The alert an erasure leaves for the operator (#453): its page spells out
 * what is done by hand and links the account, and its resolve form offers the
 * code. The row itself is proven against PostgreSQL in
 * tests/integration/accountErasure.postgres.test.ts.
 */

const USER = "auth0|followup-user";
const RAISED = new Date("2026-09-24T18:00:00Z");

function alert(extra: Partial<AlertView> = {}): AlertView {
  return {
    alertId: "a1b2c3d4-0000-4000-8000-000000000001",
    alertType: "account_erasure_followup",
    severity: "warning",
    status: "open",
    orderId: null,
    sourceEventId: null,
    accountUserId: USER,
    details: JSON.stringify({ userId: USER }),
    createdAt: RAISED,
    updatedAt: RAISED,
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionCode: null,
    ...extra,
  };
}

describe("the erasure follow-up alert", () => {
  it("lists what is done by hand, names the account and links it", () => {
    const page = String(renderAlertDetail({ alert: alert(), actions: html`` }));
    expect(page).toContain("What is left to do");
    expect(page).toContain("Auth0 tenant");
    expect(page).toContain("LETTER_IRL_BETA_ALLOWED_SUBJECTS");
    expect(page).toContain("LETTER_IRL_ADMIN_USER_IDS");
    expect(page).toContain("auth0_user_deleted");
    expect(page).toContain(`href="/accounts/${encodeURIComponent(USER)}"`);
    expect(page).toContain(`data-copy="${USER}"`);
  });

  it("adds no steps and no account row to other alerts", () => {
    const page = String(
      renderAlertDetail({
        alert: alert({ alertType: "pack_refund_failed", accountUserId: null, orderId: "ord-1" }),
        actions: html``,
      }),
    );
    expect(page).not.toContain("What is left to do");
    expect(page).not.toContain("/accounts/");
  });

  it("shows the order where there is one, and the account where there is not", () => {
    expect(String(alertSubjectLink(alert()))).toContain(`href="/accounts/${encodeURIComponent(USER)}"`);
    expect(String(alertSubjectLink(alert({ orderId: "ord-1" })))).toContain('href="/orders/ord-1"');
    expect(String(alertSubjectLink(alert({ accountUserId: null })))).toBe("—");
  });

  it("fills the resolve field with a suggested code, and leaves it empty otherwise", () => {
    const suggested = String(
      alertActionPanel({ alertId: alert().alertId, status: "open", mode: "full", suggestedResolution: "auth0_user_deleted" }),
    );
    expect(suggested).toMatch(/name="resolutionCode"[^>]*value="auth0_user_deleted"/);
    const plain = String(alertActionPanel({ alertId: alert().alertId, status: "open", mode: "full" }));
    expect(plain).toMatch(/name="resolutionCode"[^>]*value=""/);
  });
});

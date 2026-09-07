import { AdminFoundationError } from "../errors.js";
import { renderAccount, renderLetter, renderLookup } from "../pages/accounts.js";
import { renderAudit, renderCommandDetail, renderCommands } from "../pages/audit.js";
import { renderAlertDetail, renderAlerts, renderDisputes, renderJobDetail, renderJobs, renderMaintenance } from "../pages/operations.js";
import { renderOrder } from "../pages/orders.js";
import { renderOverview } from "../pages/overview.js";
import { listRecentAccounts, readAccountDetail, readLetterDetail, revealAccountEmail } from "../queries/accounts.js";
import { listAlerts, listRecentWebhookEvents, listUnmatchedWebhookEvents, parseAlertFilter, readAlert } from "../queries/alerts.js";
import { listAuditEvents, listCommandRuns, listOperatorAuditEvents, readCommandRun } from "../queries/audit.js";
import { listBlockedAccounts, listDisputes } from "../queries/disputes.js";
import { listAttentionJobs, listRecentJobs, readJob } from "../queries/jobs.js";
import { lookupIdentifier, normalizeLookupTerm } from "../queries/lookup.js";
import { readMaintenanceHealth } from "../queries/maintenance.js";
import { readOrderDetail } from "../queries/orders.js";
import { boundedLimit } from "../queries/paging.js";
import type { SafeHtml } from "../ui/html.js";
import { EMPTY_ACTIONS, notFound, textResponse, type RequestContext, type RouteHandler } from "./app.js";
import { AdminRouter } from "./router.js";

/**
 * The read-only routes (slice 1). Every handler runs its queries inside one
 * READ ONLY transaction on the reader pool and renders server-side; the only
 * POSTs are the audited email reveal and logout.
 */

export interface RouteExtensions {
  /** Per-target action panels supplied by the command slices. */
  alertActions?: (context: RequestContext, alertId: string, status: string) => SafeHtml;
  jobActions?: (context: RequestContext, jobId: string, status: string, providerOutcome: string) => SafeHtml;
  orderActions?: (context: RequestContext, orderId: string, refundable: boolean) => SafeHtml;
}

export const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/lookup", label: "Lookup" },
  { href: "/alerts", label: "Alerts" },
  { href: "/jobs", label: "Jobs" },
  { href: "/disputes", label: "Disputes" },
  { href: "/maintenance", label: "Maintenance" },
  { href: "/stripe", label: "Stripe" },
  { href: "/audit", label: "Audit" },
  { href: "/commands", label: "Commands" },
  { href: "/elevate", label: "Elevate" },
];

export function registerReadRoutes(
  router: AdminRouter<RouteHandler>,
  clientScript: { path: string; body: string },
  extensions: RouteExtensions = {},
): AdminRouter<RouteHandler> {
  router.add("GET", "/", async (context) => {
    const data = await context.read(async (client) => ({
      health: await readMaintenanceHealth(client),
      alerts: (await listAlerts(client, { filter: "active", limit: 10 })).rows,
      jobs: await listAttentionJobs(client, 10),
    }));
    return context.render("Overview", renderOverview(data));
  }, { name: "overview" });

  router.add("GET", "/lookup", async (context) => {
    const raw = context.url.searchParams.get("q") ?? undefined;
    const term = normalizeLookupTerm(raw);
    const data = await context.read(async (client) => ({
      matches: term ? await lookupIdentifier(client, term) : null,
      recent: await listRecentAccounts(client, 10),
    }));
    return context.render(
      "Lookup",
      renderLookup({ term: term ?? raw ?? null, matches: data.matches, invalid: raw !== undefined && term === null, recent: data.recent }),
    );
  }, { name: "lookup" });

  router.add("GET", "/accounts/:userId", async (context) => {
    const detail = await context.read((client) => readAccountDetail(client, context.params.userId));
    if (!detail) notFound();
    return context.render(
      `Account ${detail.account.userId}`,
      renderAccount({ detail, revealedEmail: null, csrfToken: context.csrfToken }),
    );
  }, { name: "account" });

  // A read with an audit trail: the email is shown once, on this response
  // only, and the reason lands in admin_audit_events. Allowed in read-only
  // mode because it changes nothing; the reader role can insert audit rows.
  router.add("POST", "/accounts/:userId/reveal", async (context) => {
    const reason = (context.form?.get("reason") ?? "").trim();
    const userId = context.params.userId;
    if (reason.length < 8 || reason.length > 500) {
      await context.appendAudit({
        action: "pii.reveal",
        targetType: "user",
        targetId: userId,
        outcome: "denied",
        errorCode: "ADMIN_INVALID_REQUEST",
        inputSummary: { field: "email" },
      });
      throw new AdminFoundationError("ADMIN_INVALID_REQUEST");
    }
    const data = await context.read(async (client) => ({
      detail: await readAccountDetail(client, userId),
      email: await revealAccountEmail(client, userId),
    }));
    if (!data.detail) notFound();
    await context.appendAudit({
      action: "pii.reveal",
      targetType: "user",
      targetId: userId,
      reason,
      inputSummary: { field: "email" },
      outcome: "succeeded",
    });
    return context.render(
      `Account ${userId}`,
      renderAccount({ detail: data.detail, revealedEmail: data.email, csrfToken: context.csrfToken }),
    );
  }, { name: "account.reveal", write: false });

  router.add("GET", "/orders/:orderId", async (context) => {
    const detail = await context.read((client) => readOrderDetail(client, context.params.orderId));
    if (!detail) notFound();
    const actions = extensions.orderActions
      ? extensions.orderActions(context, detail.order.orderId, detail.pack?.refundable ?? false)
      : EMPTY_ACTIONS;
    return context.render(`Order ${detail.order.orderId}`, renderOrder({ detail, actions }));
  }, { name: "order" });

  router.add("GET", "/letters/:letterId", async (context) => {
    const detail = await context.read((client) => readLetterDetail(client, context.params.letterId));
    if (!detail) notFound();
    return context.render(`Letter ${detail.letter.letterId}`, renderLetter({ detail }));
  }, { name: "letter" });

  router.add("GET", "/jobs", async (context) => {
    const data = await context.read(async (client) => ({
      attention: await listAttentionJobs(client, 100),
      recent: await listRecentJobs(client, 50),
    }));
    return context.render("Jobs", renderJobs(data));
  }, { name: "jobs" });

  router.add("GET", "/jobs/:jobId", async (context) => {
    const job = await context.read((client) => readJob(client, context.params.jobId));
    if (!job) notFound();
    const actions = extensions.jobActions
      ? extensions.jobActions(context, job.jobId, job.status, job.providerOutcome)
      : EMPTY_ACTIONS;
    return context.render(`Job ${job.jobId}`, renderJobDetail({ job, actions }));
  }, { name: "job" });

  router.add("GET", "/alerts", async (context) => {
    const filter = parseAlertFilter(context.url.searchParams.get("filter") ?? undefined);
    const cursor = context.url.searchParams.get("cursor") ?? undefined;
    const limit = boundedLimit(context.url.searchParams.get("limit"), 50);
    const data = await context.read(async (client) => ({
      page: await listAlerts(client, { filter, limit, cursor }),
      unmatched: await listUnmatchedWebhookEvents(client, 50),
    }));
    return context.render(
      "Alerts",
      renderAlerts({ filter, alerts: data.page.rows, nextCursor: data.page.nextCursor, unmatched: data.unmatched }),
    );
  }, { name: "alerts" });

  router.add("GET", "/alerts/:alertId", async (context) => {
    if (!/^[0-9a-f-]{36}$/i.test(context.params.alertId)) notFound();
    const alert = await context.read((client) => readAlert(client, context.params.alertId));
    if (!alert) notFound();
    const actions = extensions.alertActions
      ? extensions.alertActions(context, alert.alertId, alert.status)
      : EMPTY_ACTIONS;
    return context.render(`Alert ${alert.alertType}`, renderAlertDetail({ alert, actions }));
  }, { name: "alert" });

  router.add("GET", "/disputes", async (context) => {
    const openOnly = context.url.searchParams.get("all") !== "1";
    const data = await context.read(async (client) => ({
      disputes: await listDisputes(client, { limit: 100, openOnly }),
      blocked: await listBlockedAccounts(client, 100),
    }));
    return context.render("Disputes", renderDisputes({ ...data, openOnly }));
  }, { name: "disputes" });

  router.add("GET", "/maintenance", async (context) => {
    const data = await context.read(async (client) => ({
      health: await readMaintenanceHealth(client),
      recentWebhooks: await listRecentWebhookEvents(client, 25),
    }));
    return context.render("Maintenance", renderMaintenance(data));
  }, { name: "maintenance" });

  router.add("GET", "/audit", async (context) => {
    const outcomeParam = context.url.searchParams.get("outcome");
    const outcome = outcomeParam === "denied" || outcomeParam === "failed" ? outcomeParam : null;
    const cursor = context.url.searchParams.get("cursor") ?? undefined;
    const data = await context.read(async (client) => ({
      page: await listAuditEvents(client, { limit: 50, cursor, outcome: outcome ?? undefined }),
      operatorEvents: await listOperatorAuditEvents(client, 25),
    }));
    return context.render(
      "Audit",
      renderAudit({ events: data.page.rows, nextCursor: data.page.nextCursor, outcome, operatorEvents: data.operatorEvents }),
    );
  }, { name: "audit" });

  router.add("GET", "/commands", async (context) => {
    const cursor = context.url.searchParams.get("cursor") ?? undefined;
    const page = await context.read((client) => listCommandRuns(client, { limit: 50, cursor }));
    return context.render("Commands", renderCommands({ commands: page.rows, nextCursor: page.nextCursor }));
  }, { name: "commands" });

  router.add("GET", "/commands/:commandId", async (context) => {
    if (!/^[0-9a-f-]{36}$/i.test(context.params.commandId)) notFound();
    const detail = await context.read((client) => readCommandRun(client, context.params.commandId));
    if (!detail) notFound();
    return context.render(`Command ${detail.command.action}`, renderCommandDetail(detail));
  }, { name: "command" });

  router.add("POST", "/session/logout", async (context) => {
    await context.appendAudit({
      action: "admin.session_end",
      targetType: "session",
      outcome: "succeeded",
    });
    context.sessions.destroy(context.session.id);
    context.clearSessionCookie();
    return { kind: "raw", status: 200, body: "signed out; close the tab", contentType: "text/plain; charset=utf-8" };
  }, { name: "session.logout", write: false });

  router.add("GET", "/assets/:file", async (context) => {
    if (`/assets/${context.params.file}` !== clientScript.path) notFound();
    return textResponse(clientScript.body, "text/javascript; charset=utf-8");
  }, { name: "assets" });

  return router;
}

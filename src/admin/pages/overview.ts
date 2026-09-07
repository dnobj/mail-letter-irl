import type { AlertView } from "../queries/alerts.js";
import type { JobView } from "../queries/jobs.js";
import type { MaintenanceHealth } from "../queries/maintenance.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { statusBadge } from "../ui/format.js";
import { alertLink, card, jobLink, letterLink, orderLink, table, when } from "./common.js";

export function renderOverview(input: {
  health: MaintenanceHealth;
  alerts: AlertView[];
  jobs: JobView[];
}): SafeHtml {
  const { health } = input;
  const cards = [
    card("open alerts", health.alerts.open, health.alerts.open > 0 ? "warn" : ""),
    card("critical alerts", health.alerts.critical, health.alerts.critical > 0 ? "bad" : ""),
    card("held jobs", health.outbox.held, health.outbox.held > 0 ? "bad" : ""),
    card("failed jobs", health.outbox.failed, health.outbox.failed > 0 ? "warn" : ""),
    card("outbox due", health.outbox.pendingDue, health.outbox.pendingDue > 5 ? "warn" : ""),
    card("stuck orders", health.stuckOrders, health.stuckOrders > 0 ? "bad" : ""),
    card("unmatched webhooks", health.unmatchedWebhookEvents, health.unmatchedWebhookEvents > 0 ? "warn" : ""),
    card("pack refunds in flight", health.packRefundsInFlight, health.packRefundsInFlight > 0 ? "warn" : ""),
    card("blocked accounts", health.blockedAccounts, health.blockedAccounts > 0 ? "warn" : ""),
    card("accounts", health.accounts),
  ];

  return html`<h1>Operations overview</h1>
<div class="cards">${join(cards)}</div>
<p class="muted">Last webhook received ${when(health.lastWebhookReceivedAt)}; latest migration <code>${health.latestMigration ?? "unknown"}</code>.
Revenue figures are deliberately absent: Stripe is the ledger of record for money.</p>

<h2>Alerts needing attention</h2>
${table(
  "Open and acknowledged alerts",
  ["Alert", "Type", "Severity", "Status", "Order", "Raised"],
  input.alerts.map((alert) => [
    alertLink(alert.alertId),
    html`${alert.alertType}`,
    statusBadge(alert.severity),
    statusBadge(alert.status),
    orderLink(alert.orderId),
    when(alert.createdAt),
  ]),
  "none open.",
)}
<p><a href="/alerts">All alerts →</a></p>

<h2>Jobs needing attention</h2>
${table(
  "Held, failed and stale jobs",
  ["Job", "Letter", "Status", "Provider outcome", "Hold reason", "Attempts", "Updated"],
  input.jobs.map((job) => [
    jobLink(job.jobId),
    letterLink(job.letterId),
    statusBadge(job.status),
    statusBadge(job.providerOutcome),
    html`${job.holdReason ?? "—"}`,
    html`${job.attempts}/${job.maxAttempts}`,
    when(job.updatedAt),
  ]),
  "none.",
)}
<p><a href="/jobs">All jobs →</a></p>`;
}

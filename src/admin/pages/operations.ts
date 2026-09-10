import type { AlertFilter, AlertView, WebhookEventView } from "../queries/alerts.js";
import type { BlockedAccountView, DisputeView } from "../queries/disputes.js";
import type { JobView } from "../queries/jobs.js";
import type { MaintenanceHealth } from "../queries/maintenance.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { formatDate, formatMoney, statusBadge, yesNo } from "../ui/format.js";
import {
  accountLink,
  alertLink,
  copyButton,
  definitionList,
  jobLink,
  letterLink,
  orderLink,
  pager,
  table,
  when,
} from "./common.js";

export function renderAlerts(input: {
  filter: AlertFilter;
  alerts: AlertView[];
  nextCursor: string | null;
  unmatched: WebhookEventView[];
}): SafeHtml {
  const filters: AlertFilter[] = ["active", "open", "acknowledged", "resolved", "all"];
  return html`<h1>Operational alerts</h1>
<p>Filter: ${join(
    filters.map((filter) =>
      filter === input.filter
        ? html`<strong>${filter}</strong>`
        : html`<a href="/alerts?filter=${filter}">${filter}</a>`,
    ),
    " · ",
  )}</p>
${table(
  "Alerts",
  ["Alert", "Type", "Severity", "Status", "Order", "Source event", "Raised", "Updated"],
  input.alerts.map((alert) => [
    alertLink(alert.alertId),
    html`${alert.alertType}`,
    statusBadge(alert.severity),
    statusBadge(alert.status),
    orderLink(alert.orderId),
    html`<span class="mono">${alert.sourceEventId ?? "—"}</span>`,
    when(alert.createdAt),
    when(alert.updatedAt),
  ]),
)}
${pager(input.nextCursor, "/alerts", { filter: input.filter })}

<h2>Unmatched webhook events</h2>
<p class="muted">Money events Stripe delivered that matched no order. Each one needs an explanation before it is dismissed.</p>
${table(
  "Unmatched events",
  ["Event", "Type", "Object", "Payment intent", "Metadata order", "Received"],
  input.unmatched.map((event) => [
    html`<span class="mono">${event.eventId}</span>`,
    html`${event.eventType}`,
    html`<span class="mono">${event.providerObjectId ?? "—"}</span>`,
    html`<span class="mono">${event.providerPaymentIntentId ?? "—"}</span>`,
    orderLink(event.metadataOrderId),
    when(event.receivedAt),
  ]),
  "none.",
)}`;
}

export function renderAlertDetail(input: { alert: AlertView; actions: SafeHtml }): SafeHtml {
  const { alert } = input;
  return html`<h1>Alert <span class="mono">${alert.alertId}</span> ${copyButton(alert.alertId)}</h1>
${definitionList([
  ["type", alert.alertType],
  ["severity", statusBadge(alert.severity)],
  ["status", statusBadge(alert.status)],
  ["order", orderLink(alert.orderId)],
  ["source event", html`<span class="mono">${alert.sourceEventId ?? "—"}</span>`],
  ["raised", html`${formatDate(alert.createdAt)} (${when(alert.createdAt)})`],
  ["acknowledged", when(alert.acknowledgedAt)],
  ["resolved", html`${alert.resolvedAt ? when(alert.resolvedAt) : "—"} ${alert.resolutionCode ? html`<code>${alert.resolutionCode}</code>` : ""}`],
])}
<h2>Details</h2>
<pre>${alert.details}</pre>
${input.actions}`;
}

export function renderJobs(input: { attention: JobView[]; recent: JobView[] }): SafeHtml {
  const rows = (jobs: JobView[]) =>
    jobs.map((job) => [
      jobLink(job.jobId),
      letterLink(job.letterId),
      accountLink(job.userId),
      statusBadge(job.status),
      statusBadge(job.providerOutcome),
      html`${job.holdReason ?? "—"}`,
      html`${job.attempts}/${job.maxAttempts}`,
      when(job.nextAttemptAt),
      when(job.updatedAt),
    ]);
  const headers = ["Job", "Letter", "Account", "Status", "Provider outcome", "Hold reason", "Attempts", "Next attempt", "Updated"];
  return html`<h1>Outbox jobs</h1>
<h2>Needing attention</h2>
${table("Held, failed and stale jobs", headers, rows(input.attention), "none.")}
<h2>Recent</h2>
${table("Recent jobs", headers, rows(input.recent))}`;
}

export function renderJobDetail(input: { job: JobView; actions: SafeHtml }): SafeHtml {
  const { job } = input;
  return html`<h1>Job <span class="mono">${job.jobId}</span> ${copyButton(job.jobId)}</h1>
${definitionList([
  ["letter", letterLink(job.letterId)],
  ["account", accountLink(job.userId)],
  ["letter status", statusBadge(job.letterStatus)],
  ["mail type", job.mailType],
  ["funding", html`${job.fundingType} ${job.fundingOrderId ? orderLink(job.fundingOrderId) : ""}`],
  ["status", statusBadge(job.status)],
  ["provider outcome", statusBadge(job.providerOutcome)],
  ["attempts", html`${job.attempts} of ${job.maxAttempts}`],
  ["scheduled", when(job.scheduledAt)],
  ["next attempt", when(job.nextAttemptAt)],
  ["locked", when(job.lockedAt)],
  ["provider order id", yesNo(job.hasProviderOrderId)],
  ["dispatch started", when(job.providerDispatchStartedAt)],
  ["held", html`${job.heldAt ? when(job.heldAt) : "—"} ${job.holdReason ?? ""}`],
  ["operator resolution", job.operatorResolution],
  ["resolved", when(job.resolvedAt)],
  ["last error", job.lastError],
  ["created", when(job.createdAt)],
  ["updated", when(job.updatedAt)],
])}
${input.actions}`;
}

export function renderDisputes(input: {
  disputes: DisputeView[];
  blocked: BlockedAccountView[];
  openOnly: boolean;
}): SafeHtml {
  return html`<h1>Disputes and blocked accounts</h1>
<p>${input.openOnly ? html`Showing open disputes. <a href="/disputes?all=1">Show all</a>` : html`Showing all disputes. <a href="/disputes">Open only</a>`}</p>
${table(
  "Stripe disputes",
  ["Dispute", "Status", "Amount", "Reason", "Account", "Order", "Evidence due", "Opened", "Resolved"],
  input.disputes.map((dispute) => [
    html`<span class="mono">${dispute.disputeId}</span>`,
    statusBadge(dispute.status),
    html`${formatMoney(dispute.amountCents, dispute.currency)}`,
    html`${dispute.reason ?? "—"}`,
    accountLink(dispute.userId),
    orderLink(dispute.orderId),
    when(dispute.evidenceDueBy),
    when(dispute.stripeCreatedAt ?? dispute.createdAt),
    when(dispute.resolvedAt),
  ]),
  "none.",
)}
<h2>Accounts with sends blocked</h2>
${table(
  "Blocked accounts",
  ["Account", "Email", "Reason", "Since", "Open disputes", "Lost disputes"],
  input.blocked.map((account) => [
    accountLink(account.userId),
    html`${account.emailMasked}`,
    html`<code>${account.sendsBlockedReason}</code>`,
    when(account.sendsBlockedAt),
    html`${account.openDisputes}`,
    html`${account.lostDisputes}`,
  ]),
  "none.",
)}`;
}

export function renderMaintenance(input: { health: MaintenanceHealth; recentWebhooks: WebhookEventView[] }): SafeHtml {
  const { health } = input;
  return html`<h1>Maintenance health</h1>
${definitionList([
  ["database marker", html`<code>${health.marker ?? "missing"}</code>`],
  ["latest migration", html`<code>${health.latestMigration ?? "unknown"}</code>`],
  ["stuck orders (paid / fulfilment pending / refund pending for 30+ min)", health.stuckOrders],
  ["orders in amount-mismatch quarantine", health.quarantinedOrders],
  ["outbox due now", health.outbox.pendingDue],
  ["outbox scheduled later", health.outbox.pendingLater],
  ["processing for 10+ min", health.outbox.processingStale],
  ["pack refunds awaiting Stripe", health.packRefundsInFlight],
  ["pending admin operations", health.pendingAdminOperations],
  ["last webhook received", when(health.lastWebhookReceivedAt)],
])}
<h2>Maintenance tasks</h2>
${table(
  "maintenance_tasks",
  ["Task", "Last started", "Last completed", "Locked", "Last status", "Error recorded"],
  health.tasks.map((task) => [
    html`<code>${task.taskName}</code>`,
    when(task.lastStartedAt),
    when(task.lastCompletedAt),
    when(task.lockedAt),
    statusBadge(task.lastStatus),
    html`${yesNo(task.lastErrorPresent)}`,
  ]),
)}
<h2>Recent webhook events</h2>
${table(
  "stripe_webhook_events",
  ["Event", "Type", "Processing", "Order", "Received"],
  input.recentWebhooks.map((event) => [
    html`<span class="mono">${event.eventId}</span>`,
    html`${event.eventType}`,
    statusBadge(event.processingStatus),
    orderLink(event.orderId ?? event.metadataOrderId),
    when(event.receivedAt),
  ]),
)}`;
}

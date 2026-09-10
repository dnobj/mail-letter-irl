import type { AuditEventView, CommandRunView, OperatorAuditView } from "../queries/audit.js";
import { html, type SafeHtml } from "../ui/html.js";
import { formatDate, statusBadge } from "../ui/format.js";
import { commandLink, copyButton, definitionList, pager, table, when } from "./common.js";

export function renderAudit(input: {
  events: AuditEventView[];
  nextCursor: string | null;
  outcome: string | null;
  operatorEvents: OperatorAuditView[];
}): SafeHtml {
  return html`<h1>Audit log</h1>
<p>Filter: ${input.outcome ? html`<a href="/audit">all</a>` : html`<strong>all</strong>`} ·
 ${input.outcome === "denied" ? html`<strong>denied</strong>` : html`<a href="/audit?outcome=denied">denied</a>`} ·
 ${input.outcome === "failed" ? html`<strong>failed</strong>` : html`<a href="/audit?outcome=failed">failed</a>`}</p>
${table(
  "admin_audit_events (append-only)",
  ["When", "Actor", "Action", "Target", "Outcome", "Error", "Reason", "Command", "Correlation"],
  input.events.map((event) => [
    when(event.occurredAt),
    html`<code>${event.actorId}</code>`,
    html`${event.action}`,
    html`${event.targetType} <span class="mono">${event.targetId ?? ""}</span>`,
    statusBadge(event.outcome),
    html`${event.errorCode ?? "—"}`,
    html`${event.reason ?? "—"}`,
    commandLink(event.commandId),
    html`<span class="mono">${event.correlationId.slice(0, 8)}…</span>`,
  ]),
)}
${pager(input.nextCursor, "/audit", input.outcome ? { outcome: input.outcome } : {})}

<h2>Domain operator audit</h2>
<p class="muted">The commerce services' own hashed audit rows. Identities and targets are stored as hashes and are not shown.</p>
${table(
  "commerce_operator_audit_events",
  ["When", "Operation", "Target type", "Reason code", "Outcome", "Before", "After"],
  input.operatorEvents.map((event) => [
    when(event.createdAt),
    html`${event.operation}`,
    html`${event.targetType}`,
    html`<code>${event.reasonCode}</code>`,
    statusBadge(event.outcome),
    html`<span class="mono">${event.beforeState}</span>`,
    html`<span class="mono">${event.afterState}</span>`,
  ]),
)}`;
}

export function renderCommands(input: { commands: CommandRunView[]; nextCursor: string | null }): SafeHtml {
  return html`<h1>Command history</h1>
${table(
  "admin_command_runs",
  ["Requested", "Command", "Action", "Target", "Actor", "Status", "Error", "Completed"],
  input.commands.map((command) => [
    when(command.requestedAt),
    commandLink(command.id),
    html`${command.action}`,
    html`${command.targetType} <span class="mono">${command.targetId ?? ""}</span>`,
    html`<code>${command.actorId}</code>`,
    statusBadge(command.status),
    html`${command.errorCode ?? "—"}`,
    when(command.completedAt),
  ]),
)}
${pager(input.nextCursor, "/commands")}`;
}

export function renderCommandDetail(input: { command: CommandRunView; events: AuditEventView[] }): SafeHtml {
  const { command } = input;
  return html`<h1>Command <span class="mono">${command.id}</span> ${copyButton(command.id)}</h1>
${definitionList([
  ["action", command.action],
  ["target", html`${command.targetType} <span class="mono">${command.targetId ?? "—"}</span>`],
  ["actor", html`<code>${command.actorId}</code>`],
  ["status", statusBadge(command.status)],
  ["error", command.errorCode],
  ["requested", formatDate(command.requestedAt)],
  ["started", formatDate(command.startedAt)],
  ["completed", formatDate(command.completedAt)],
  ["idempotency key", html`<span class="mono">${command.idempotencyKey}</span>`],
  ["preview digest", html`<span class="mono">${command.previewDigest}</span>`],
  ["expected version", command.expectedVersion],
  ["correlation", html`<span class="mono">${command.correlationId}</span>`],
])}
<h2>Sanitized result</h2>
<pre>${command.sanitizedResult}</pre>
<h2>Audit events</h2>
${table(
  "Events for this command",
  ["When", "Action", "Outcome", "Error", "Reason", "Before", "After"],
  input.events.map((event) => [
    when(event.occurredAt),
    html`${event.action}`,
    statusBadge(event.outcome),
    html`${event.errorCode ?? "—"}`,
    html`${event.reason ?? "—"}`,
    html`<span class="mono">${event.beforeSummary}</span>`,
    html`<span class="mono">${event.afterSummary}</span>`,
  ]),
)}`;
}

import type { RetentionPreviewResult } from "../../services/retentionService.js";
import type { FeatureRequestView, QuarantineView, RetentionCounts, RoutingRow, StuckLetterView, TokenStatsView } from "../queries/ops.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { statusBadge } from "../ui/format.js";
import { accountLink, card, definitionList, letterLink, table, when } from "./common.js";

export function renderRetention(input: {
  counts: RetentionCounts;
  quarantine: QuarantineView[];
  report: RetentionPreviewResult | null;
  reportError: string | null;
}): SafeHtml {
  const { counts, report } = input;
  return html`<h1>Content retention</h1>
<p class="muted">Report mode only. The hourly maintenance run redacts content past the published window; the restore path stays closed until its known defects are fixed, so there is no restore button here.</p>
<div class="cards">
  ${card("letters redacted", counts.lettersRedacted)}
  ${card("drafts redacted", counts.draftsRedacted)}
  ${card("quarantined letters", counts.quarantinedLetters)}
  ${card("quarantined drafts", counts.quarantinedDrafts)}
  ${card("quarantine purge due", counts.purgeDueNow, counts.purgeDueNow > 0 ? "warn" : "")}
</div>
<h2>What the next enforcing run would touch</h2>
${
  report
    ? html`${definitionList([
        ["letters due", html`${report.letters.due} (past window: ${report.letters.pastWindow}; held back: ${report.letters.heldBack}; oldest due ${report.letters.oldestDueDays ?? "—"} days)`],
        ["paid drafts due", html`${report.paidDrafts.due} (held back: ${report.paidDrafts.heldBack})`],
        ["abandoned drafts due", html`${report.abandonedDrafts.due} (held back: ${report.abandonedDrafts.heldBack})`],
      ])}
      ${report.errors.length > 0 ? html`<p class="bad-text">Report errors: ${report.errors.join(", ")}</p>` : ""}`
    : html`<p class="bad-text">The report could not run${input.reportError ? html` (<code>${input.reportError}</code>)` : ""}.</p>`
}
<h2>Quarantine (metadata only)</h2>
${table(
  "redacted_content_quarantine",
  ["Source", "Row", "Quarantined", "Purge after"],
  input.quarantine.map((row) => [
    html`${row.sourceTable}`,
    row.sourceTable === "letters" ? letterLink(row.sourceId) : html`<span class="mono">${row.sourceId}</span>`,
    when(row.quarantinedAt),
    when(row.purgeAfter),
  ]),
  "empty.",
)}`;
}

export function renderRouting(input: {
  rows: RoutingRow[];
  providers: string[];
  defaultProvider: string;
  stuck: StuckLetterView[];
  mode: string;
  environment: string;
}): SafeHtml {
  return html`<h1>Provider routing</h1>
<p class="muted">Environment default provider: <code>${input.defaultProvider}</code>. Registered providers: ${join(input.providers.map((provider) => html`<code>${provider}</code>`), " ")}. A change is validated against this registry and, in production, never accepts <code>dummy</code>.</p>
${table(
  "provider_routing",
  ["Mail type", "Provider", "Enabled", "Updated", "By", "Change"],
  input.rows.map((row) => [
    html`<code>${row.mailType}</code>`,
    html`${row.provider}`,
    html`${row.enabled ? "yes" : "no"}`,
    when(row.updatedAt),
    html`${row.updatedBy ?? "—"}`,
    html`<form method="get" action="/commands/routing.update/preview" class="inline">
  <input type="hidden" name="target" value="${row.mailType}">
  <label class="muted" for="provider-${row.mailType}">to</label>
  <select id="provider-${row.mailType}" name="provider">${join(
    input.providers.map(
      (provider) => html`<option value="${provider}" ${provider === row.provider ? "selected" : ""}>${provider}</option>`,
    ),
  )}</select>
  <label><input type="checkbox" name="enabled" value="on" ${row.enabled ? "checked" : ""}> enabled</label>
  <button type="submit">Preview…</button>
</form>`,
  ]),
)}
${input.mode !== "full" ? html`<p class="muted">Read-only mode: previews work, execution is refused.</p>` : ""}
<h2>Provider status sync</h2>
<form method="get" action="/commands/mail.status_sync/preview" class="stack">
  <input type="hidden" name="target" value="letters">
  <label for="sync-days">Letters created in the last (days)</label>
  <input type="number" id="sync-days" name="days" min="1" max="90" value="30">
  <label for="sync-mode">Mode</label>
  <select id="sync-mode" name="dryRun">
    <option value="on">dry run: report what would change</option>
    <option value="off">apply: update statuses and history</option>
  </select>
  <div><button type="submit">Preview sync…</button></div>
</form>
<h2>Letters stuck in a non-terminal status for 14+ days</h2>
${table(
  "Stuck letters",
  ["Letter", "Status", "Created", "Days"],
  input.stuck.map((letter) => [letterLink(letter.letterId), statusBadge(letter.status), when(letter.createdAt), html`${letter.daysInStatus}`]),
  "none.",
)}`;
}

export function renderSupport(input: { tokenStats: TokenStatsView; featureRequests: FeatureRequestView[] }): SafeHtml {
  const { tokenStats } = input;
  return html`<h1>Support</h1>
<h2>Personal access tokens</h2>
<div class="cards">
  ${card("tokens", tokenStats.total)}
  ${card("active", tokenStats.active)}
  ${card("revoked", tokenStats.revoked)}
  ${card("used today", tokenStats.usedToday)}
  ${card("used in 7 days", tokenStats.usedLast7Days)}
</div>
<h2>Feature requests</h2>
<p class="muted">Contact emails are never selectable here; consent is shown as a flag.</p>
${table(
  "feature_requests",
  ["Title", "Category", "Status", "Account", "Consent", "Created", "Reviewed", "Resolved"],
  input.featureRequests.map((request) => [
    html`<details><summary>${request.title}</summary><p>${request.description}</p>${request.attemptedAction ? html`<p class="muted">Attempted: ${request.attemptedAction}</p>` : ""}${request.adminNotes ? html`<p class="muted">Notes: ${request.adminNotes}</p>` : ""}</details>`,
    html`${request.category}`,
    statusBadge(request.status),
    accountLink(request.userId),
    html`${request.contactConsent ? "yes" : "no"}`,
    when(request.createdAt),
    when(request.reviewedAt),
    when(request.resolvedAt),
  ]),
  "none.",
)}`;
}

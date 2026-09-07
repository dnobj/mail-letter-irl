import type { reconcileStripePayments } from "../../services/stripeReconciliationService.js";
import type { AuditEventView } from "../queries/audit.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { formatDate, formatMoney, statusBadge } from "../ui/format.js";
import { csrfField } from "../ui/layout.js";
import { accountLink, orderLink, table, when } from "./common.js";

export type ReconciliationResult = Awaited<ReturnType<typeof reconcileStripePayments>>;
export type ReconciliationDiscrepancy = ReconciliationResult["discrepancies"][number];

export function renderStripe(input: {
  days: number;
  result: ReconciliationResult | null;
  recentRuns: AuditEventView[];
  csrfToken: string;
  mode: "read-only" | "full";
  stripeKeyMode: string;
  stripeKeyRestricted: boolean;
}): SafeHtml {
  const keyAbsent = input.stripeKeyMode === "absent";
  return html`<h1>Stripe reconciliation</h1>
<p class="muted">Compares Stripe checkout sessions and refunds with the orders and ledger for the chosen window. Reads Stripe, writes nothing but an audit row; results are shown here and summarised in the audit log without Stripe identifiers.</p>
${
  keyAbsent
    ? html`<div class="flash flash-bad" role="status"><code>STRIPE_SECRET_KEY</code> is not set on this service, so reconciliation cannot run.</div>`
    : html`<p class="muted">Stripe key: <code>${input.stripeKeyMode}${input.stripeKeyRestricted ? " (restricted)" : ""}</code>.</p>`
}
<form method="post" action="/stripe/reconcile" class="stack" data-single-submit>
  ${csrfField(input.csrfToken)}
  <label for="days">Look back (days, 1 to 90)</label>
  <input type="number" id="days" name="days" min="1" max="90" value="${input.days}" required>
  <div><button type="submit" ${keyAbsent ? "disabled" : ""}>Run reconciliation</button></div>
</form>
${input.result ? renderResult(input.result, input.mode) : ""}
<h2>Recent runs</h2>
${table(
  "stripe.reconcile audit events",
  ["When", "Actor", "Window", "Outcome", "Summary"],
  input.recentRuns.map((run) => [
    when(run.occurredAt),
    html`<code>${run.actorId}</code>`,
    html`${run.targetId ?? "—"}`,
    statusBadge(run.outcome),
    html`<span class="mono">${run.afterSummary}</span>`,
  ]),
  "none yet.",
)}`;
}

function renderResult(result: ReconciliationResult, mode: "read-only" | "full"): SafeHtml {
  const summary = result.summary;
  return html`<h2>Result for ${formatDate(result.period.start)} to ${formatDate(result.period.end)}</h2>
<div class="cards">
  <div class="card"><div class="n">${summary.stripePayments}</div><div class="muted">Stripe payments</div></div>
  <div class="card"><div class="n">${summary.ourCredits}</div><div class="muted">our grants</div></div>
  <div class="card"><div class="n">${summary.matched}</div><div class="muted">matched</div></div>
  <div class="card ${summary.missingInOurSystem > 0 ? "bad" : ""}"><div class="n">${summary.missingInOurSystem}</div><div class="muted">missing on our side</div></div>
  <div class="card ${summary.missingInStripe > 0 ? "bad" : ""}"><div class="n">${summary.missingInStripe}</div><div class="muted">missing in Stripe</div></div>
  <div class="card ${summary.amountMismatches > 0 ? "warn" : ""}"><div class="n">${summary.amountMismatches}</div><div class="muted">amount mismatches</div></div>
  <div class="card ${summary.unprocessedRefunds > 0 ? "warn" : ""}"><div class="n">${summary.unprocessedRefunds}</div><div class="muted">unprocessed refunds</div></div>
</div>
${
  result.recommendations.length > 0
    ? html`<ul>${join(result.recommendations.map((line) => html`<li>${line}</li>`))}</ul>`
    : ""
}
${table(
  "Discrepancies",
  ["Type", "Severity", "Order", "Account", "Stripe session", "Stripe amount", "Ours", "Credits", "Message", "Suggested action", "Repair"],
  result.discrepancies.map((discrepancy) => [
    html`${discrepancy.type}`,
    statusBadge(discrepancy.severity),
    orderLink(discrepancy.orderId),
    accountLink(discrepancy.userId),
    html`<span class="mono">${discrepancy.stripeSessionId ?? "—"}</span>`,
    html`${discrepancy.stripeAmount === undefined ? "—" : formatMoney(discrepancy.stripeAmount, discrepancy.stripeCurrency)}`,
    html`${discrepancy.ourAmount === undefined ? "—" : formatMoney(discrepancy.ourAmount, discrepancy.stripeCurrency)}`,
    html`${discrepancy.expectedCredits ?? "—"} / ${discrepancy.actualCredits ?? "—"}`,
    html`${discrepancy.message}`,
    html`${discrepancy.suggestedAction}`,
    repairForm(discrepancy, mode),
  ]),
  "none: Stripe and the ledger agree for this window.",
)}`;
}

function repairForm(discrepancy: ReconciliationDiscrepancy, mode: "read-only" | "full"): SafeHtml {
  if (
    discrepancy.type !== "missing_credit" ||
    !discrepancy.orderId ||
    !discrepancy.stripeSessionId ||
    !discrepancy.expectedCredits
  ) {
    return html`—`;
  }
  if (mode !== "full") return html`<span class="muted">full mode only</span>`;
  return html`<form method="get" action="/commands/order.repair_grant/preview" class="inline">
  <input type="hidden" name="target" value="${discrepancy.orderId}">
  <input type="hidden" name="stripeSessionId" value="${discrepancy.stripeSessionId}">
  <input type="hidden" name="expectedCredits" value="${discrepancy.expectedCredits}">
  <input type="hidden" name="paidAmountCents" value="${discrepancy.stripeAmount ?? 0}">
  <input type="hidden" name="paidCurrency" value="${(discrepancy.stripeCurrency ?? "usd").toLowerCase()}">
  <button type="submit">Preview repair…</button>
</form>`;
}

/** The proportional-refund entry point on the order page. */
export function orderActionPanel(input: {
  orderId: string;
  refundable: boolean;
  commandEnabled: boolean;
  mode: "read-only" | "full";
}): SafeHtml {
  if (!input.commandEnabled) {
    return html`<h2>Proportional refund</h2>
<p class="muted">Disabled on this service: <code>LETTER_IRL_PACK_REFUND_COMMAND_ENABLED</code> is not <code>true</code>. Until it is, the house rule applies: full refunds of unused packs only, from the Stripe Dashboard.</p>`;
  }
  if (!input.refundable) {
    return html`<h2>Proportional refund</h2><p class="muted">Not available for this order right now (see the pack figures above).</p>`;
  }
  return html`<h2>Proportional refund</h2>
<form method="get" action="/commands/order.refund_letters/preview" class="stack">
  <input type="hidden" name="target" value="${input.orderId}">
  <label for="letters">Unspent letters to refund</label>
  <input type="number" id="letters" name="letters" min="1" max="500" step="1" required>
  <label for="reasonCode">Reason code (lowercase, 3 to 80 characters, e.g. <code>customer_request</code>)</label>
  <input type="text" id="reasonCode" name="reasonCode" pattern="[a-z][a-z0-9_]{2,79}" required autocomplete="off">
  <div><button type="submit">Preview refund…</button></div>
</form>
${input.mode !== "full" ? html`<p class="muted">Read-only mode: the preview works, execution is refused.</p>` : ""}`;
}

import type { OrderDetail } from "../queries/orders.js";
import { html, type SafeHtml } from "../ui/html.js";
import { formatMoney, statusBadge, yesNo } from "../ui/format.js";
import {
  accountLink,
  alertLink,
  commandLink,
  copyButton,
  definitionList,
  jobLink,
  letterLink,
  orderLink,
  table,
  when,
} from "./common.js";

/**
 * Why an order is held as REFUND_NOT_COMPLETED, and what an operator can do.
 * Such an order is held only while it waits for its refund, and moves on
 * only to refunded (which clears the code) or disputed. A disputed one is not
 * told to refund: while a chargeback is open Stripe refuses a refund, and the
 * dispute decides where the money goes; an inquiry does not stop one, so
 * Stripe is where to look (#730). Either way a new refund may already be
 * pending at Stripe, where its webhook has not yet completed the order.
 */
function heldRefundNote(status: string): SafeHtml {
  if (status === "refund_pending") {
    return html` — its refund failed or was cancelled at Stripe, and the sweep will not make another. Check its refunds in Stripe first, since a new one may still be pending. Then refund it again in Stripe once the cause is fixed, or settle it by hand, and resolve its <code>refund_not_completed</code> alert (docs/deployment.md).`;
  }
  return html` — its refund failed or was cancelled at Stripe, and the order has since become <code>${status}</code>. Check its refunds and any dispute in Stripe before refunding it: Stripe refuses a refund while a chargeback is open, and the dispute decides where the money goes. Then resolve its <code>refund_not_completed</code> alert (docs/deployment.md).`;
}

export function renderOrder(input: { detail: OrderDetail; actions: SafeHtml }): SafeHtml {
  const { detail } = input;
  const { order, pack } = detail;
  return html`<h1>Order <span class="mono">${order.orderId}</span> ${copyButton(order.orderId)}</h1>
${
  order.holdReason
    ? html`<div class="flash flash-bad" role="status">Held since ${when(detail.heldAt)} (reason: <code>${order.holdReason}</code>; previous status <code>${detail.holdPreviousStatus ?? "—"}</code>).</div>`
    : ""
}
${
  order.lastErrorCode
    ? html`<div class="flash flash-warn" role="status">Last error code <code>${order.lastErrorCode}</code>${order.lastErrorCode === "PAYMENT_AMOUNT_MISMATCH" ? html` — this order is quarantined from the automatic refund sweep until an operator releases it.` : ""}${order.lastErrorCode === "REFUND_NOT_COMPLETED" ? heldRefundNote(order.status) : ""}</div>`
    : ""
}
${definitionList([
  ["account", html`${accountLink(detail.userId)} (${detail.emailMasked})`],
  ["type", html`${order.orderType} / ${order.productCode}`],
  ["status", html`${statusBadge(order.status)}${order.stripeDisputeStatus ? html` dispute: ${statusBadge(order.stripeDisputeStatus)}` : ""}`],
  ["amount", html`${formatMoney(order.amountCents, order.currency)}${detail.amountKnown ? "" : html` <span class="warn-text">(amount not known)</span>`}`],
  ["refunded amount", formatMoney(order.amountRefundedCents, order.currency)],
  ["Stripe payment intent", html`<span class="mono">${order.stripePaymentIntentId ?? "—"}</span>${order.stripePaymentIntentId ? copyButton(order.stripePaymentIntentId) : ""}`],
  ["Stripe checkout session", html`<span class="mono">${order.stripeCheckoutSessionId ?? "—"}</span>`],
  ["letter (Pay & Send)", letterLink(order.letterId)],
  ["refund attempts", order.refundAttempts],
  ["created", when(order.createdAt)],
  ["paid", when(order.paidAt)],
  ["fulfilled", when(order.fulfilledAt)],
  ["refunded", when(order.refundedAt)],
  ["updated", when(order.updatedAt)],
])}

${
  pack
    ? html`<h2>Pack figures</h2>
<div class="cards">
  <div class="card"><div class="n">${pack.lettersInPack}</div><div class="muted">letters in pack</div></div>
  <div class="card"><div class="n">${pack.lettersRemaining}</div><div class="muted">unspent letters (${pack.creditsRemaining} credits on live lots)</div></div>
  <div class="card"><div class="n">${pack.lettersConsumed}</div><div class="muted">letters sent from this pack</div></div>
  <div class="card"><div class="n">${pack.lettersRefundedBefore}</div><div class="muted">letters already refunded</div></div>
  <div class="card"><div class="n">${formatMoney(pack.perLetterCents, order.currency)}</div><div class="muted">per letter (floored)</div></div>
  <div class="card ${pack.refundable ? "" : "warn"}"><div class="n">${formatMoney(pack.maxProportionalRefundCents, order.currency)}</div><div class="muted">maximum proportional refund</div></div>
</div>
<p class="muted">Proportional refunds are floored once on the product (N × amount ÷ letters in pack) so a refund never exceeds the pro-rata share. ${pack.refundable ? "This pack has unspent letters that a proportional refund could return." : html`Not refundable proportionally right now: ${pack.refundableReason}.`}</p>`
    : ""
}

${input.actions}

<h2>Ledger lots funded by this order</h2>
${table(
  "Lots",
  ["Lot", "Source", "Initial", "Remaining", "Status", "Spendable", "Activated", "Expires", "Reason"],
  detail.lots.map((lot) => [
    html`<span class="mono">${lot.ledgerId.slice(0, 8)}…</span>`,
    html`${lot.sourceType}`,
    html`${lot.initialAmount}`,
    html`${lot.remainingAmount}`,
    statusBadge(lot.status),
    html`${yesNo(lot.spendable)}`,
    when(lot.activatedAt),
    when(lot.expiresAt),
    html`${lot.sourceReason ?? "—"}`,
  ]),
)}

<h2>Letters funded</h2>
${table(
  "Letters",
  ["Letter", "Type", "Status", "Cost", "Job", "Created", "Sent"],
  detail.letters.map((letter) => [
    letterLink(letter.letterId),
    html`${letter.mailType}`,
    statusBadge(letter.status),
    html`${letter.creditsCost}`,
    html`${letter.jobId ? html`${jobLink(letter.jobId)} ${statusBadge(letter.jobStatus)}` : "—"}`,
    when(letter.createdAt),
    when(letter.sentAt),
  ]),
)}

<h2>Proportional refunds</h2>
${table(
  "commerce_pack_refunds",
  ["Refund", "Status", "Letters", "Amount", "Reason", "Stripe refund", "Attempts", "Error", "Command", "Created", "Settled"],
  detail.packRefunds.map((refund) => [
    html`<span class="mono">${refund.packRefundId.slice(0, 8)}…</span>`,
    statusBadge(refund.status),
    html`${refund.letters} (${refund.credits} credits)`,
    html`${formatMoney(refund.amountCents, refund.currency)}`,
    html`<code>${refund.reasonCode}</code>`,
    html`${yesNo(refund.hasStripeRefundId)}`,
    html`${refund.stripeAttempts}`,
    html`${refund.lastErrorCode ?? "—"} ${refund.failureReason ?? ""}`,
    commandLink(refund.adminCommandId),
    when(refund.createdAt),
    when(refund.settledAt ?? refund.failedAt),
  ]),
  "none.",
)}

<h2>Order events</h2>
${table(
  "commerce_order_events",
  ["When", "Event", "From", "To", "Metadata"],
  detail.events.map((event) => [
    when(event.createdAt),
    html`${event.eventType}`,
    html`${event.fromStatus ?? "—"}`,
    html`${event.toStatus ?? "—"}`,
    html`<span class="mono">${event.metadata}</span>`,
  ]),
)}

<h2>Webhook events</h2>
${table(
  "stripe_webhook_events",
  ["Event", "Type", "Processing", "Received"],
  detail.webhookEvents.map((event) => [
    html`<span class="mono">${event.eventId}</span>`,
    html`${event.eventType}`,
    statusBadge(event.processingStatus),
    when(event.receivedAt),
  ]),
  "none.",
)}

<h2>Alerts</h2>
${table(
  "Alerts on this order",
  ["Alert", "Type", "Severity", "Status", "Raised"],
  detail.alerts.map((alert) => [
    alertLink(alert.alertId),
    html`${alert.alertType}`,
    statusBadge(alert.severity),
    statusBadge(alert.status),
    when(alert.createdAt),
  ]),
  "none.",
)}

<h2>Disputes</h2>
${table(
  "Disputes on this payment",
  ["Dispute", "Status", "Amount", "Reason", "Evidence due", "Opened"],
  detail.disputes.map((dispute) => [
    html`<span class="mono">${dispute.disputeId}</span>`,
    statusBadge(dispute.status),
    html`${formatMoney(dispute.amountCents, dispute.currency)}`,
    html`${dispute.reason ?? "—"}`,
    when(dispute.evidenceDueBy),
    when(dispute.stripeCreatedAt ?? dispute.createdAt),
  ]),
  "none.",
)}
<p class="muted">Related: ${orderLink(order.orderId)} in the account view ${accountLink(detail.userId)}.</p>`;
}

import type { AccountDetail, AccountListItem, LetterDetail } from "../queries/accounts.js";
import type { LookupMatch } from "../queries/lookup.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { creditsToLetters, formatMoney, statusBadge, yesNo } from "../ui/format.js";
import { csrfField } from "../ui/layout.js";
import {
  accountLink,
  copyButton,
  definitionList,
  jobLink,
  letterLink,
  link,
  orderLink,
  table,
  when,
} from "./common.js";

export function renderLookup(input: {
  term: string | null;
  matches: LookupMatch[] | null;
  invalid: boolean;
  recent: AccountListItem[];
}): SafeHtml {
  return html`<h1>Lookup</h1>
<form method="get" action="/lookup" class="stack" role="search">
  <label for="q">Exact identifier: Auth0 subject, email, order, letter, job, Stripe payment intent / session / refund / charge / dispute / event id, alert id, pack refund id, command id</label>
  <input type="search" id="q" name="q" value="${input.term ?? ""}" maxlength="255" autocomplete="off" required>
  <div><button type="submit">Look up</button></div>
</form>
${input.invalid ? html`<p class="bad-text" role="alert">The identifier is empty, too long, or contains whitespace.</p>` : ""}
${
  input.matches
    ? input.matches.length === 0
      ? html`<p role="status">No exact match for <code>${input.term}</code>. Lookups are exact; partial matching is deliberately not offered.</p>`
      : html`<h2>Matches</h2><ul>${join(
          input.matches.map((match) => html`<li>${match.kind}: ${link(match.href, match.label)}</li>`),
        )}</ul>`
    : ""
}
<h2>Recently created accounts</h2>
${table(
  "Newest accounts",
  ["Account", "Email", "Credits", "Tier", "Blocked", "Created"],
  input.recent.map((account) => [
    accountLink(account.userId),
    html`${account.emailMasked}`,
    html`${account.credits}`,
    html`${account.tier}`,
    html`${account.sendsBlockedReason ?? "—"}`,
    when(account.createdAt),
  ]),
)}`;
}

export function renderAccount(input: {
  detail: AccountDetail;
  revealedEmail: string | null;
  csrfToken: string | null;
  actions?: SafeHtml;
}): SafeHtml {
  const { account } = input.detail;
  return html`<h1>Account <span class="mono">${account.userId}</span> ${copyButton(account.userId)}</h1>
${
  account.sendsBlockedAt
    ? html`<div class="flash flash-bad" role="status">Sends blocked since ${when(account.sendsBlockedAt)} (reason: <code>${account.sendsBlockedReason}</code>).</div>`
    : ""
}
${
  account.cacheMismatch
    ? html`<div class="flash flash-warn" role="status">The cached balance (${account.credits}) differs from the ledger (${account.ledgerAvailable}). The daily reconcile-balances pass repairs this; an operator command is not needed.</div>`
    : ""
}
<div class="cards">
  <div class="card"><div class="n">${creditsToLetters(account.ledgerAvailable)}</div><div class="muted">letters available (${account.ledgerAvailable} credits)</div></div>
  <div class="card"><div class="n">${creditsToLetters(account.creditsPurchased)}</div><div class="muted">letters purchased (lifetime)</div></div>
  <div class="card"><div class="n">${creditsToLetters(account.creditsUsed)}</div><div class="muted">letters used</div></div>
  <div class="card"><div class="n">${input.detail.imageQuota.remaining}</div><div class="muted">images remaining of ${input.detail.imageQuota.allowance}</div></div>
  <div class="card ${input.detail.openDisputes > 0 ? "bad" : ""}"><div class="n">${input.detail.openDisputes}</div><div class="muted">open disputes</div></div>
</div>

<h2>Identity</h2>
${definitionList([
  ["email", input.revealedEmail ? html`<code>${input.revealedEmail}</code> <span class="warn-text">(revealed; this view is audited)</span>` : html`${account.emailMasked}`],
  ["tier", html`${account.tier}${account.tierOverride ? html` (override: <strong>${account.tierOverride}</strong>)` : ""}`],
  ["tier calculated", when(account.tierCalculatedAt)],
  ["return address", html`${account.returnAddressValidatedAt ? html`validated ${when(account.returnAddressValidatedAt)}` : "none validated"} (never shown here)`],
  ["created", when(account.createdAt)],
  ["updated", when(account.updatedAt)],
  ["image generations used", account.imageGenerationsUsed],
])}
${
  input.revealedEmail
    ? ""
    : html`<form method="post" action="/accounts/${encodeURIComponent(account.userId)}/reveal" class="stack" data-single-submit>
  ${csrfField(input.csrfToken)}
  <label for="reveal-reason">Reveal the email address (writes an audit event with this reason)</label>
  <input type="text" id="reveal-reason" name="reason" minlength="8" maxlength="500" required placeholder="e.g. support ticket 123 identity check">
  <div><button type="submit">Reveal email</button></div>
</form>`
}

${input.actions ?? ""}

<h2>Ledger lots</h2>
${table(
  "Credit ledger",
  ["Lot", "Source", "Reference", "Order", "Initial", "Remaining", "Status", "Spendable", "Activated", "Expires", "Reason"],
  input.detail.lots.map((lot) => [
    html`<span class="mono">${lot.ledgerId.slice(0, 8)}…</span>`,
    html`${lot.sourceType}`,
    html`<span class="mono">${lot.sourceReferenceId ?? "—"}</span>`,
    orderLink(lot.sourceOrderId),
    html`${lot.initialAmount}`,
    html`${lot.remainingAmount}`,
    statusBadge(lot.status),
    html`${yesNo(lot.spendable)}`,
    when(lot.activatedAt),
    when(lot.expiresAt),
    html`${lot.sourceReason ?? lot.description ?? "—"}`,
  ]),
)}

<h2>Orders</h2>
${table(
  "Orders",
  ["Order", "Type", "Product", "Status", "Letters", "Refunded", "Amount", "Refunded amount", "Hold / error", "Created"],
  input.detail.orders.map((order) => [
    orderLink(order.orderId),
    html`${order.orderType}`,
    html`${order.productCode}`,
    statusBadge(order.status),
    html`${order.credits === null ? "—" : creditsToLetters(order.credits)}`,
    html`${order.credits === null ? "—" : creditsToLetters(order.creditsRefunded)}`,
    html`${formatMoney(order.amountCents, order.currency)}`,
    html`${formatMoney(order.amountRefundedCents, order.currency)}`,
    html`${order.holdReason ?? order.lastErrorCode ?? "—"}`,
    when(order.createdAt),
  ]),
)}

<h2>Letters</h2>
${table(
  "Letters (metadata only; content and recipients are never shown here)",
  ["Letter", "Type", "Status", "Funding", "Cost", "Provider", "Tracking", "Job", "Created", "Sent"],
  input.detail.letters.map((letter) => [
    letterLink(letter.letterId),
    html`${letter.mailType}`,
    statusBadge(letter.status),
    html`${letter.fundingType}${letter.fundingOrderId ? html` (${orderLink(letter.fundingOrderId)})` : ""}`,
    html`${letter.creditsCost}`,
    html`${letter.provider ?? "—"}`,
    html`${yesNo(letter.hasTrackingId)}`,
    html`${letter.jobId ? html`${jobLink(letter.jobId)} ${statusBadge(letter.jobStatus)}` : "—"}`,
    when(letter.createdAt),
    when(letter.sentAt),
  ]),
)}

<h2>Promo redemptions</h2>
${table(
  "Redemptions",
  ["Code", "Campaign", "Redeemed", "Lot"],
  input.detail.redemptions.map((redemption) => [
    html`<code>${redemption.campaignCode}</code>`,
    html`${redemption.campaignName}`,
    when(redemption.redeemedAt),
    html`<span class="mono">${redemption.ledgerId.slice(0, 8)}…</span>`,
  ]),
)}

<h2>Personal access tokens</h2>
${table(
  "Tokens (hashes are never selectable)",
  ["Name", "Prefix", "Status", "Last used", "Expires", "Created", "Revoked"],
  input.detail.tokens.map((token) => [
    html`${token.name}`,
    html`<code>…${token.tokenPrefix}</code>`,
    statusBadge(token.status),
    when(token.lastUsedAt),
    when(token.expiresAt),
    when(token.createdAt),
    when(token.revokedAt),
  ]),
)}

<h2>Recent credit transactions</h2>
${table(
  "Transactions",
  ["When", "Type", "Amount", "Balance after", "Reference", "Description"],
  input.detail.transactions.map((transaction) => [
    when(transaction.createdAt),
    html`${transaction.type}`,
    html`${transaction.amount}`,
    html`${transaction.balanceAfter}`,
    html`${transaction.referenceType ?? ""} <span class="mono">${transaction.referenceId ?? ""}</span>`,
    html`${transaction.description ?? ""}`,
  ]),
)}`;
}

export function renderLetter(input: { detail: LetterDetail }): SafeHtml {
  const { letter, job } = input.detail;
  return html`<h1>Letter <span class="mono">${letter.letterId}</span> ${copyButton(letter.letterId)}</h1>
<p class="muted">Content, recipient and preview are never rendered in the panel. Provider references are shown as present or absent only.</p>
${definitionList([
  ["account", accountLink(input.detail.userId)],
  ["status", statusBadge(letter.status)],
  ["mail type", letter.mailType],
  ["funding", html`${letter.fundingType} ${letter.fundingOrderId ? orderLink(letter.fundingOrderId) : ""}`],
  ["credits cost", letter.creditsCost],
  ["provider", letter.provider],
  ["tracking id", yesNo(letter.hasTrackingId)],
  ["created", when(letter.createdAt)],
  ["sent", when(letter.sentAt)],
  ["status updated", when(letter.statusUpdatedAt)],
  ["content redacted", when(letter.redactedAt)],
])}

<h2>Outbox job</h2>
${
  job
    ? definitionList([
        ["job", jobLink(job.jobId)],
        ["status", statusBadge(job.status)],
        ["provider outcome", statusBadge(job.providerOutcome)],
        ["attempts", html`${job.attempts} of ${job.maxAttempts}`],
        ["next attempt", when(job.nextAttemptAt)],
        ["locked", when(job.lockedAt)],
        ["provider order id", yesNo(job.hasProviderOrderId)],
        ["dispatch started", when(job.providerDispatchStartedAt)],
        ["held", html`${job.heldAt ? when(job.heldAt) : "—"} ${job.holdReason ?? ""}`],
        ["operator resolution", job.operatorResolution],
        ["resolved", when(job.resolvedAt)],
        ["last error", job.lastError],
      ])
    : html`<p class="muted">No outbox row (drafts and legacy letters have none).</p>`
}

<h2>Status history</h2>
${table(
  "Status history",
  ["When", "From", "To", "Provider status", "Source"],
  input.detail.history.map((entry) => [
    when(entry.changedAt),
    html`${entry.oldStatus ?? "—"}`,
    statusBadge(entry.newStatus),
    html`${entry.providerRawStatus ?? "—"}`,
    html`${entry.source}`,
  ]),
)}`;
}

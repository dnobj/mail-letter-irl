import type { ErasureFollowupView, ErasureOperationView } from "../../services/accountErasureService.js";
import type { AccountDetail } from "../queries/accounts.js";
import type { EntitlementView } from "../queries/images.js";
import type { OrderDetail } from "../queries/orders.js";
import { html, type SafeHtml } from "../ui/html.js";
import { statusBadge } from "../ui/format.js";
import { table, when } from "./common.js";

/** Operator entry points on the account page: all lead to previews. */
export function accountActionPanel(input: { detail: AccountDetail; entitlements: EntitlementView[]; mode: string }): SafeHtml {
  const userId = input.detail.account.userId;
  return html`<h2>Operator actions</h2>
<div class="actions">
${
  input.detail.account.sendsBlockedAt
    ? html`<form method="get" action="/commands/account.unblock_sends/preview" class="inline">
  <input type="hidden" name="target" value="${userId}">
  <button type="submit">Preview lifting the send block…</button>
</form>`
    : html`<span class="muted">Sends are not blocked.</span>`
}
</div>
<form method="get" action="/commands/account.adjust_balance/preview" class="stack">
  <input type="hidden" name="target" value="${userId}">
  <label for="adjust-direction">Adjust letter balance</label>
  <select id="adjust-direction" name="direction">
    <option value="add">add letters (never expire; not a purchase)</option>
    <option value="remove">remove letters (soonest-expiring lots first)</option>
  </select>
  <label for="adjust-letters">Letters</label>
  <input type="number" id="adjust-letters" name="letters" min="1" max="500" step="1" required>
  <div><button type="submit">Preview adjustment…</button></div>
</form>
<form method="get" action="/commands/account.set_tier/preview" class="stack">
  <input type="hidden" name="target" value="${userId}">
  <label for="tier-override">Tier override (calculated: ${input.detail.account.tier}; override now: ${input.detail.account.tierOverride ?? "none"})</label>
  <select id="tier-override" name="tier">
    <option value="clear">clear the override</option>
    <option value="standard">standard</option>
    <option value="trusted">trusted</option>
  </select>
  <div><button type="submit">Preview tier change…</button></div>
</form>
<form method="get" action="/commands/account.grant_images/preview" class="stack">
  <input type="hidden" name="target" value="${userId}">
  <label for="grant-quantity">Grant image generations (compensation, valid one year)</label>
  <input type="number" id="grant-quantity" name="quantity" min="1" max="50" step="1" required>
  <div><button type="submit">Preview grant…</button></div>
</form>
${input.mode !== "full" ? html`<p class="muted">Read-only mode: previews work, execution is refused.</p>` : ""}
<h2>Image entitlements</h2>
${table(
  "image_entitlements",
  ["Source", "Reference", "Order", "Quantity", "Consumed", "Status", "Expires", "Created"],
  input.entitlements.map((entitlement) => [
    html`${entitlement.sourceType}`,
    html`<span class="mono">${entitlement.sourceReferenceId}</span>`,
    html`${entitlement.sourceOrderId ?? "—"}`,
    html`${entitlement.quantity}`,
    html`${entitlement.consumedQuantity}`,
    statusBadge(entitlement.status),
    when(entitlement.expiresAt),
    when(entitlement.createdAt),
  ]),
  "none.",
)}`;
}

/**
 * Erasure, last on the account page (#289): where the account stands, and the
 * entry point to the preview when it can be erased. The result shown is the
 * worker's own record, counts and codes only.
 */
export function accountErasurePanel(input: {
  userId: string;
  erased: boolean;
  erasure: ErasureOperationView | null;
  /** The follow-up alert the erasure opened (#453); none before migration 036. */
  followup?: ErasureFollowupView | null;
  mode: string;
}): SafeHtml {
  const { erasure } = input;
  const form = html`<form method="get" action="/commands/account.erase/preview" class="inline">
  <input type="hidden" name="target" value="${input.userId}">
  <button type="submit">Preview erasing this account…</button>
</form>`;
  let body: SafeHtml;
  if (input.erased) {
    // Two operators confirming at once queue two erasures; the second finds
    // the account already erased, and the counts are on the first.
    const byEarlier = erasure?.result?.alreadyErased === true;
    body = html`<p>Erased${erasure?.completedAt ? html` ${when(erasure.completedAt)}` : ""}. ${erasureFollowup(input.followup ?? null)}</p>
${
  byEarlier
    ? html`<p class="muted">The newest erasure found the account already erased; the counts are on the one before it.</p>`
    : erasure?.result
      ? html`<p class="muted mono">${JSON.stringify(erasure.result)}</p>`
      : ""
}`;
  } else if (erasure && (erasure.status === "pending" || erasure.status === "processing")) {
    body = html`<p>Erasure queued ${when(erasure.requestedAt)}. The next hourly maintenance run carries it out${erasure.attempts > 0 ? html`; ${erasure.attempts} attempts so far` : ""}.</p>`;
  } else if (erasure?.status === "failed") {
    body = html`<p>The last erasure did not run: <span class="mono">${erasure.errorCode ?? "unknown"}</span>${erasure.completedAt ? html`, ${when(erasure.completedAt)}` : ""}.</p>
${erasure.result ? html`<p class="muted mono">${JSON.stringify(erasure.result)}</p>` : ""}
${form}`;
  } else {
    body = html`<p class="muted">Removes the email, the saved address, letter content and addresses, drafts, uploads, access tokens, feature requests and unredeemed gift codes. Orders, the ledger, disputes and refunds are kept, without personal details.</p>
${form}`;
  }
  return html`<h2>Erase account</h2>
${body}
${input.mode !== "full" ? html`<p class="muted">Read-only mode: the preview works, queuing is refused.</p>` : ""}`;
}

/**
 * Where the work an erasure leaves by hand stands: the Auth0 user and the two
 * id lists (docs/account-erasure.md). An account erased before migration 036
 * has no alert, and gets the plain reminder.
 */
function erasureFollowup(followup: ErasureFollowupView | null): SafeHtml {
  if (!followup) {
    return html`The Auth0 user with this id is deleted by hand, in the tenant (docs/account-erasure.md).`;
  }
  const link = html`<a href="/alerts/${encodeURIComponent(followup.alertId)}">follow-up alert</a>`;
  if (followup.status === "resolved") {
    return html`Follow-up done: the ${link} was resolved${followup.resolvedAt ? html` ${when(followup.resolvedAt)}` : ""}${followup.resolutionCode ? html` (<code>${followup.resolutionCode}</code>)` : ""}.`;
  }
  return html`<strong>Still to do by hand:</strong> delete the Auth0 user with this id in the tenant, and take the id out of the beta and admin lists if it is there. The ${link} has the steps; resolve it when they are done.`;
}

/** The quarantine release on the order page, shown only while quarantined. */
export function orderQuarantinePanel(input: { detail: OrderDetail; mode: string }): SafeHtml {
  if (input.detail.order.lastErrorCode !== "PAYMENT_AMOUNT_MISMATCH") return html``;
  return html`<h2>Amount-mismatch quarantine</h2>
<p>The paid amount did not match the product's price, so the automatic refund sweep leaves this order alone until an operator decides.</p>
<form method="get" action="/commands/order.release_quarantine/preview" class="inline">
  <input type="hidden" name="target" value="${input.detail.order.orderId}">
  <button type="submit">Preview release…</button>
</form>
${input.mode !== "full" ? html`<p class="muted">Read-only mode: the preview works, execution is refused.</p>` : ""}`;
}

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

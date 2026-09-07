import { PROMO_STATUS_TRANSITIONS } from "../../services/promoService.js";
import type { PromoCampaignStatus } from "../../services/types.js";
import type { CampaignRedemptionView, CampaignView } from "../queries/promos.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { statusBadge } from "../ui/format.js";
import { accountLink, copyButton, definitionList, table, when } from "./common.js";

export function renderPromos(input: { campaigns: CampaignView[]; mode: string }): SafeHtml {
  return html`<h1>Promo campaigns</h1>
<p><a href="/promos/new">Create a campaign…</a></p>
${table(
  "Campaigns",
  ["Code", "Name", "Status", "Credits", "Redeemed", "Cap", "Starts", "Ends", "Updated"],
  input.campaigns.map((campaign) => [
    html`<a class="mono" href="/promos/${campaign.campaignId}">${campaign.code}</a>`,
    html`${campaign.name}`,
    statusBadge(campaign.status),
    html`${campaign.creditsAmount}`,
    html`${campaign.currentRedemptions}`,
    html`${campaign.maxTotalRedemptions ?? "∞"}`,
    when(campaign.startsAt),
    when(campaign.endsAt),
    when(campaign.updatedAt),
  ]),
)}`;
}

export function renderPromoForm(): SafeHtml {
  return html`<h1>Create promo campaign</h1>
<p class="muted">This form leads to a preview; nothing is created until the preview is confirmed.</p>
<form method="get" action="/commands/promo.create/preview" class="stack" id="promo-form">
  <label for="code">Code (3 to 50 characters: letters, digits, underscore, hyphen; stored uppercase)</label>
  <input type="text" id="code" name="code" pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,49}" required autocomplete="off">
  <label for="name">Name</label>
  <input type="text" id="name" name="name" maxlength="255" required>
  <label for="description">Description (optional)</label>
  <textarea id="description" name="description" maxlength="2000" rows="3"></textarea>
  <label for="creditsAmount">Credits per redemption (2 credits = 1 letter)</label>
  <input type="number" id="creditsAmount" name="creditsAmount" min="0" max="1000" step="1" required>
  <label for="expirationDays">Credits expire after (days)</label>
  <input type="number" id="expirationDays" name="expirationDays" min="1" max="3650" value="90" required>
  <label for="maxTotalRedemptions">Total redemptions cap (blank for unlimited)</label>
  <input type="number" id="maxTotalRedemptions" name="maxTotalRedemptions" min="1" max="100000" step="1">
  <label for="maxPerUser">Redemptions per user</label>
  <input type="number" id="maxPerUser" name="maxPerUser" min="1" max="10" value="1" required>
  <label for="endsAt">End date (optional, UTC)</label>
  <input type="date" id="endsAt" name="endsAt">
  <label><input type="checkbox" name="requiresNewUser" value="on"> New accounts only</label>
  <div><button type="submit" data-copy-target="code">Preview…</button></div>
</form>
<script-free-note hidden></script-free-note>`;
}

export function renderPromoDetail(input: {
  campaign: CampaignView;
  redemptions: CampaignRedemptionView[];
  mode: string;
}): SafeHtml {
  const { campaign } = input;
  const nextStatuses = PROMO_STATUS_TRANSITIONS[campaign.status as PromoCampaignStatus] ?? [];
  return html`<h1>Campaign <span class="mono">${campaign.code}</span> ${copyButton(campaign.code)}</h1>
${definitionList([
  ["name", campaign.name],
  ["description", campaign.description],
  ["status", statusBadge(campaign.status)],
  ["credits per redemption", `${campaign.creditsAmount} (${campaign.creditsAmount / 2} letters)`],
  ["expiration", campaign.expirationPolicy === "never" ? "never" : campaign.expirationPolicy === "fixed_date" ? `fixed: ${campaign.fixedExpirationDate?.toISOString() ?? "—"}` : `${campaign.expirationDays ?? "—"} days after redemption`],
  ["redemptions", `${campaign.currentRedemptions} of ${campaign.maxTotalRedemptions ?? "unlimited"}`],
  ["per user", campaign.maxPerUser],
  ["new users only", campaign.requiresNewUser ? "yes" : "no"],
  ["starts", when(campaign.startsAt)],
  ["ends", when(campaign.endsAt)],
  ["created by", campaign.createdBy],
  ["created", when(campaign.createdAt)],
  ["updated", when(campaign.updatedAt)],
])}
<h2>Actions</h2>
<div class="actions">
${join(
  nextStatuses.map(
    (status) => html`<form method="get" action="/commands/promo.transition/preview" class="inline">
  <input type="hidden" name="target" value="${campaign.campaignId}">
  <input type="hidden" name="status" value="${status}">
  <button type="submit">Preview ${status}…</button>
</form>`,
  ),
)}
${
  campaign.currentRedemptions === 0
    ? html`<form method="get" action="/commands/promo.delete/preview" class="inline">
  <input type="hidden" name="target" value="${campaign.campaignId}">
  <button type="submit" class="danger">Preview delete…</button>
</form>`
    : html`<span class="muted">Redeemed campaigns are ended, never deleted.</span>`
}
</div>
${input.mode !== "full" ? html`<p class="muted">Read-only mode: previews work, execution is refused.</p>` : ""}
<h2>Redemptions</h2>
${table(
  "Redemptions",
  ["Account", "Email", "Lot", "Redeemed"],
  input.redemptions.map((redemption) => [
    accountLink(redemption.userId),
    html`${redemption.emailMasked}`,
    html`<span class="mono">${redemption.ledgerId.slice(0, 8)}…</span>`,
    when(redemption.redeemedAt),
  ]),
  "none yet.",
)}`;
}

import type { GiftCodeView, GiftLetterView, GiftProgrammeTotals } from "../queries/gifts.js";
import { html, type SafeHtml } from "../ui/html.js";
import { statusBadge } from "../ui/format.js";
import { accountLink, definitionList, table, when } from "./common.js";

/** Chain codes read in two groups of four, as printed. */
function printed(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function codeTable(codes: GiftCodeView[], empty: string): SafeHtml {
  return table(
    "gift_codes",
    ["Code", "Issued to", "Letter", "Grants budget", "Status", "Expires", "Redeemed by", ""],
    codes.map((code) => [
      html`<span class="mono">${printed(code.code)}</span>`,
      accountLink(code.issuedToUserId),
      html`<span class="mono">${code.letterId}</span>`,
      html`${code.grantsGenerationsRemaining}`,
      html`${statusBadge(code.status)}${code.voidReason ? html` <span class="muted">${code.voidReason}</span>` : ""}`,
      when(code.expiresAt),
      code.redeemedByUserId ? accountLink(code.redeemedByUserId) : html`—`,
      code.status === "issued"
        ? html`<form method="get" action="/commands/gift.void_code/preview" class="inline">
  <input type="hidden" name="target" value="${code.code}">
  <button type="submit" class="danger">Void…</button>
</form>`
        : html``,
    ]),
    empty,
  );
}

function readOnlyNote(mode: string): SafeHtml {
  return mode !== "full" ? html`<p class="muted">Read-only mode: previews work, execution is refused.</p>` : html``;
}

/** The programme page: totals and the newest codes. */
export function renderGifts(input: { totals: GiftProgrammeTotals; codes: GiftCodeView[]; mode: string }): SafeHtml {
  return html`<h1>Gift letters</h1>
<p class="muted">docs/gift-letters.md. Seed codes are promo campaigns with a gift budget; see <a href="/promos">Promos</a>. Grant gift letters from an account's page.</p>
${definitionList([
  ["unsent gift letters", input.totals.available],
  ["gift letters sent today (UTC)", input.totals.sentToday],
  ["chain codes outstanding", input.totals.codesIssued],
  ["chain codes redeemed", input.totals.codesRedeemed],
])}
<h2>Newest chain codes</h2>
${codeTable(input.codes, "none yet.")}
${readOnlyNote(input.mode)}`;
}

/** The gift section of an account page, beside the other operator actions. */
export function accountGiftPanel(input: {
  userId: string;
  letters: GiftLetterView[];
  codes: GiftCodeView[];
  defaultGenerations: number;
  mode: string;
}): SafeHtml {
  return html`<h2>Gift letters</h2>
<form method="get" action="/commands/gift.grant/preview" class="stack">
  <input type="hidden" name="target" value="${input.userId}">
  <label for="gift-quantity">Grant gift letters (free sends that print a card)</label>
  <input type="number" id="gift-quantity" name="quantity" min="1" max="50" step="1" required>
  <label for="gift-generations">Budget per letter: further funded cards down each chain (blank for ${input.defaultGenerations}; 0 prints the plain card)</label>
  <input type="number" id="gift-generations" name="generationsRemaining" min="0" max="20" step="1">
  <label for="gift-campaign">Seed campaign code to print instead of a chain code (optional; for letters whose photo will be shared)</label>
  <input type="text" id="gift-campaign" name="cardCampaignCode" maxlength="50" autocomplete="off">
  <div><button type="submit">Preview grant…</button></div>
</form>
${table(
  "gift_letters",
  ["Source", "Budget", "Card code", "Status", "Expires", "Used by letter", "Reversed", "Created"],
  input.letters.map((gift) => [
    html`${gift.source}${gift.parentCode ? html` <span class="mono muted">${printed(gift.parentCode)}</span>` : ""}`,
    html`${gift.generationsRemaining}`,
    html`${gift.cardCampaignCode ? html`<span class="mono">${gift.cardCampaignCode}</span>` : "—"}`,
    statusBadge(gift.status),
    when(gift.expiresAt),
    gift.consumedByLetterId ? html`<span class="mono">${gift.consumedByLetterId}</span>` : html`—`,
    when(gift.sourceReversedAt),
    when(gift.createdAt),
  ]),
  "none.",
)}
<h3>Codes this account printed or redeemed</h3>
${codeTable(input.codes, "none.")}
${readOnlyNote(input.mode)}`;
}

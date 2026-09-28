import {
  ACCOUNT_DAILY_LIMIT_KEYS,
  DAILY_LIMIT_KEYS,
  DAILY_LIMIT_LABELS,
  DAILY_LIMIT_VARIABLES,
  type DailyLimitKey,
} from "../../services/dailyLimits.js";
import { formatLimitValue } from "../commands/limits.js";
import type { LimitDefaultView, LimitOverrideView, LimitRefusalsView } from "../queries/limits.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { accountLink, table, when } from "./common.js";

/**
 * The Limits page (migration 038): each daily limit with the value the API
 * is configured with, any value an operator set, the value in force, today's
 * use and refusals; a form to set a value, and a clear button for each one.
 */

export interface LimitsPageData {
  defaults: Map<DailyLimitKey, LimitDefaultView>;
  overrides: LimitOverrideView[];
  refusals: Map<DailyLimitKey, LimitRefusalsView>;
  use: { letters: number; giftLetters: number };
  mode: string;
}

function everyoneOverride(overrides: LimitOverrideView[], key: DailyLimitKey): LimitOverrideView | undefined {
  return overrides.find((override) => override.limitKey === key && override.userId === null && !override.expired);
}

function inForce(key: DailyLimitKey, data: LimitsPageData): SafeHtml {
  const override = everyoneOverride(data.overrides, key);
  if (override) return html`<strong>${formatLimitValue(key, override.value)}</strong> <span class="muted">(set)</span>`;
  const configured = data.defaults.get(key);
  return configured ? html`${formatLimitValue(key, configured.value)}` : html`<span class="muted">not reported</span>`;
}

function usedToday(key: DailyLimitKey, data: LimitsPageData): SafeHtml {
  if (key === "global_daily_mail") return html`${formatLimitValue(key, data.use.letters)}`;
  if (key === "gift_daily_send") return html`${formatLimitValue(key, data.use.giftLetters)}`;
  return html`<span class="muted">per account</span>`;
}

function refusedToday(key: DailyLimitKey, data: LimitsPageData): SafeHtml {
  const refusals = data.refusals.get(key);
  if (!refusals) return html`<span class="muted">none</span>`;
  return html`<strong>${refusals.refusals}</strong>, last ${when(refusals.lastRefusedAt)}`;
}

function until(override: LimitOverrideView): SafeHtml {
  if (!override.expiresAt) return html`until cleared`;
  return override.expired ? html`<span class="muted">expired</span> ${when(override.expiresAt)}` : html`until ${when(override.expiresAt)}`;
}

function clearButton(override: LimitOverrideView): SafeHtml {
  return html`<form method="get" action="/commands/limit.clear/preview" class="inline">
  <input type="hidden" name="target" value="${override.overrideId}">
  <button type="submit">Clear…</button>
</form>`;
}

export function renderLimits(data: LimitsPageData): SafeHtml {
  return html`<h1>Daily limits</h1>
<p class="muted">The safety stops on letters and spending, counted per UTC day. The value in force is one set here, for an account and then for everyone, or else the API's configured value. A change takes effect on the next send or checkout. When a limit refuses someone, the first refusal of the day opens an alert.</p>
${table(
  "Limits",
  ["Limit", "Configured on the API", "In force", "Used today", "Refused today"],
  DAILY_LIMIT_KEYS.map((key) => {
    const configured = data.defaults.get(key);
    return [
      html`${DAILY_LIMIT_LABELS[key]}<br><code class="muted">${DAILY_LIMIT_VARIABLES[key]}</code>`,
      configured
        ? html`${formatLimitValue(key, configured.value)} <span class="muted">(reported ${when(configured.reportedAt)})</span>`
        : html`<span class="muted">not reported yet</span>`,
      inForce(key, data),
      usedToday(key, data),
      refusedToday(key, data),
    ];
  }),
)}
<h2>Values set here</h2>
${table(
  "Overrides",
  ["Limit", "For", "Value", "Until", "Set", ""],
  data.overrides.map((override) => [
    html`${DAILY_LIMIT_LABELS[override.limitKey]}`,
    override.userId === null ? html`everyone` : accountLink(override.userId),
    html`${formatLimitValue(override.limitKey, override.value)}`,
    until(override),
    when(override.createdAt),
    clearButton(override),
  ]),
  "none; every limit runs at its configured value.",
)}
<h2>Set a limit</h2>
<form method="get" action="/commands/limit.set/preview" class="stack">
  <label for="limit-key">Limit</label>
  <select id="limit-key" name="limit">${join(
    DAILY_LIMIT_KEYS.map((key) => html`<option value="${key}">${DAILY_LIMIT_LABELS[key]}</option>`),
  )}</select>
  <label for="limit-amount">Value: letters, or whole dollars for spending</label>
  <input type="number" id="limit-amount" name="amount" min="0" max="1000000" step="1" required>
  <label for="limit-account">Account id (only for ${join(
    [...ACCOUNT_DAILY_LIMIT_KEYS].map((key) => html`${DAILY_LIMIT_LABELS[key]}`),
    " and ",
  )}; empty for everyone)</label>
  <input type="text" id="limit-account" name="account" maxlength="255" autocomplete="off">
  <label for="limit-duration">For how long</label>
  <select id="limit-duration" name="duration">
    <option value="today">the rest of today (lapses at midnight UTC)</option>
    <option value="until_cleared">until cleared</option>
  </select>
  <div><button type="submit">Preview…</button></div>
</form>
${data.mode !== "full" ? html`<p class="muted">Read-only mode: previews work, changes are refused.</p>` : ""}`;
}

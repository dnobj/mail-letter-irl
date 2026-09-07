import { html, join, type SafeHtml } from "../ui/html.js";
import { formatDate, formatRelative } from "../ui/format.js";

/** Small building blocks shared by the pages. */

export function link(href: string, text: string): SafeHtml {
  return html`<a href="${href}">${text}</a>`;
}

export function accountLink(userId: string | null | undefined): SafeHtml {
  if (!userId) return html`—`;
  return html`<a class="mono" href="/accounts/${encodeURIComponent(userId)}">${userId}</a>`;
}

export function orderLink(orderId: string | null | undefined): SafeHtml {
  if (!orderId) return html`—`;
  return html`<a class="mono" href="/orders/${encodeURIComponent(orderId)}">${orderId}</a>`;
}

export function letterLink(letterId: string | null | undefined): SafeHtml {
  if (!letterId) return html`—`;
  return html`<a class="mono" href="/letters/${encodeURIComponent(letterId)}">${letterId}</a>`;
}

export function jobLink(jobId: string | null | undefined): SafeHtml {
  if (!jobId) return html`—`;
  return html`<a class="mono" href="/jobs/${encodeURIComponent(jobId)}">${jobId}</a>`;
}

export function alertLink(alertId: string | null | undefined): SafeHtml {
  if (!alertId) return html`—`;
  return html`<a class="mono" href="/alerts/${encodeURIComponent(alertId)}">${alertId.slice(0, 8)}…</a>`;
}

export function commandLink(commandId: string | null | undefined): SafeHtml {
  if (!commandId) return html`—`;
  return html`<a class="mono" href="/commands/${encodeURIComponent(commandId)}">${commandId.slice(0, 8)}…</a>`;
}

export function when(value: Date | string | null | undefined): SafeHtml {
  if (!value) return html`<span class="muted">—</span>`;
  return html`<time datetime="${formatDate(value)}" title="${formatDate(value)}">${formatRelative(value)}</time>`;
}

export function copyButton(value: string): SafeHtml {
  return html`<button type="button" data-copy="${value}" aria-label="Copy ${value}">copy</button>`;
}

export function table(
  caption: string,
  headers: string[],
  rows: SafeHtml[][],
  empty = "Nothing to show.",
): SafeHtml {
  if (rows.length === 0) {
    return html`<p class="muted">${caption}: ${empty}</p>`;
  }
  return html`<div class="scroll"><table>
  <caption>${caption}</caption>
  <thead><tr>${join(headers.map((header) => html`<th scope="col">${header}</th>`))}</tr></thead>
  <tbody>${join(rows.map((cells) => html`<tr>${join(cells.map((cell) => html`<td>${cell}</td>`))}</tr>`))}</tbody>
</table></div>`;
}

export function definitionList(entries: Array<[string, SafeHtml | string | number | null | undefined]>): SafeHtml {
  return html`<dl class="kv">${join(
    entries.map(
      ([term, value]) =>
        html`<dt>${term}</dt><dd>${value === null || value === undefined || value === "" ? html`<span class="muted">—</span>` : value}</dd>`,
    ),
  )}</dl>`;
}

export function pager(nextCursor: string | null, basePath: string, query: Record<string, string> = {}): SafeHtml {
  if (!nextCursor) return html``;
  const params = new URLSearchParams({ ...query, cursor: nextCursor });
  return html`<p><a href="${basePath}?${params.toString()}" rel="next">Older →</a></p>`;
}

export function card(label: string, value: string | number, tone: "" | "warn" | "bad" = ""): SafeHtml {
  return html`<div class="card ${tone}"><div class="n">${value}</div><div class="muted">${label}</div></div>`;
}

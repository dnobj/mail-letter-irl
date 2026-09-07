import { html, type SafeHtml } from "../ui/html.js";

export function renderError(input: {
  status: number;
  code: string;
  message: string;
  correlationId: string;
}): SafeHtml {
  return html`<h1>${input.status} · ${input.code}</h1>
<p>${input.message}</p>
<p class="muted">Correlation id <code>${input.correlationId}</code>. The deploy log carries the detail under this id; nothing more is shown here on purpose.</p>
<p><a href="/">Back to the overview</a></p>`;
}

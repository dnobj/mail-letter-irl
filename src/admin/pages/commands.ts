import type { CommandOutcome, CommandPreview } from "../commands/runner.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { formatDate } from "../ui/format.js";
import { csrfField } from "../ui/layout.js";
import { commandLink, definitionList } from "./common.js";

/** The preview page: what will happen, and the confirmation form. */
export function renderCommandPreview(input: {
  title: string;
  commandName: string;
  targetId: string;
  preview: CommandPreview;
  previewDigest: string;
  idempotencyKey: string;
  phrase: string;
  hiddenFields: Array<[string, string]>;
  csrfToken: string;
  mode: "read-only" | "full";
  elevated: boolean;
  environment: "development" | "production";
  backHref: string;
}): SafeHtml {
  const canExecute = input.mode === "full";
  return html`<h1>${input.title}</h1>
<p class="muted">Preview. Nothing has happened yet. The confirmation below is bound to exactly this state; if the target changes before you confirm, the command is refused as stale.</p>
${definitionList(input.preview.display.map(([label, value]) => [label, value] as [string, string]))}
${
  input.preview.warnings.length > 0
    ? html`<div class="flash flash-warn" role="status"><ul>${join(input.preview.warnings.map((warning) => html`<li>${warning}</li>`))}</ul></div>`
    : ""
}
${
  !canExecute
    ? html`<div class="flash flash-bad" role="status">This service runs in read-only mode. The command cannot be executed here.</div>`
    : !input.elevated
      ? html`<div class="flash flash-warn" role="status">Writes need a current elevation. <a href="/elevate?return=${encodeURIComponent(currentUrl(input))}">Enter your authenticator code</a>, then return to this preview.</div>`
      : ""
}
<form method="post" action="/commands/${input.commandName}" class="stack" data-single-submit>
  ${csrfField(input.csrfToken)}
  <input type="hidden" name="target" value="${input.targetId}">
  <input type="hidden" name="previewDigest" value="${input.previewDigest}">
  <input type="hidden" name="expectedVersion" value="${input.preview.expectedVersion ?? ""}">
  <input type="hidden" name="idempotencyKey" value="${input.idempotencyKey}">
  ${join(input.hiddenFields.map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`))}
  <label for="reason">Reason (recorded in the audit log, never shown to the customer)</label>
  <input type="text" id="reason" name="reason" minlength="8" maxlength="500" required autocomplete="off">
  <label for="phrase">Type <code>${input.phrase}</code> to confirm</label>
  <input type="text" id="phrase" name="phrase" data-confirm-phrase="${input.phrase}" autocomplete="off" spellcheck="false" required>
  <div class="actions">
    <button type="submit" class="danger" data-needs-phrase ${canExecute && input.elevated ? "" : "disabled"}>${input.environment === "production" ? "Execute in PRODUCTION" : "Execute"}</button>
    <a href="${input.backHref}">Cancel</a>
  </div>
  <p class="muted">Preview digest <span class="mono">${input.previewDigest.slice(0, 16)}…</span>; idempotency key <span class="mono">${input.idempotencyKey}</span>. Submitting twice with the same key returns the first outcome.</p>
</form>`;
}

function currentUrl(input: { commandName: string; targetId: string; hiddenFields: Array<[string, string]> }): string {
  const params = new URLSearchParams({ target: input.targetId });
  for (const [name, value] of input.hiddenFields) params.set(name, value);
  return `/commands/${input.commandName}/preview?${params.toString()}`;
}

export function renderCommandOutcome(input: {
  title: string;
  outcome: CommandOutcome;
  backHref: string;
}): SafeHtml {
  const { outcome } = input;
  return html`<h1>${input.title}: ${outcome.status}</h1>
${
  outcome.replayed
    ? html`<div class="flash flash-warn" role="status">This confirmation was already processed; the recorded outcome is shown, and nothing ran again.</div>`
    : outcome.status === "succeeded"
      ? html`<div class="flash flash-ok" role="status">Done.</div>`
      : html`<div class="flash flash-bad" role="status">The command did not apply${outcome.errorCode ? html` (<code>${outcome.errorCode}</code>)` : ""}.</div>`
}
${definitionList([
  ["command run", commandLink(outcome.commandId)],
  ["status", outcome.status],
  ["error code", outcome.errorCode],
])}
<h2>Result</h2>
<pre>${JSON.stringify(outcome.result, null, 1)}</pre>
<p><a href="${input.backHref}">Back to the target</a></p>`;
}

export function renderElevationForm(input: {
  csrfToken: string;
  returnTo: string;
  elevatedUntil: Date | null;
  lockedUntil: Date | null;
  message: string | null;
  ttlMinutes: number;
  mode: "read-only" | "full";
}): SafeHtml {
  return html`<h1>Elevate this session</h1>
<p>Writes require a code from your authenticator, valid for ${input.ttlMinutes} minutes. Keep the authenticator on a different device from the one you are browsing on.</p>
${input.mode !== "full" ? html`<div class="flash flash-bad" role="status">Read-only mode: there is nothing to elevate for.</div>` : ""}
${input.elevatedUntil ? html`<div class="flash flash-ok" role="status">Elevated until ${formatDate(input.elevatedUntil)}.</div>` : ""}
${input.lockedUntil ? html`<div class="flash flash-bad" role="status">Elevation is locked until ${formatDate(input.lockedUntil)} after repeated failures.</div>` : ""}
${input.message ? html`<div class="flash flash-warn" role="alert">${input.message}</div>` : ""}
<form method="post" action="/elevate" class="stack" data-single-submit>
  ${csrfField(input.csrfToken)}
  <input type="hidden" name="return" value="${input.returnTo}">
  <label for="code">Six-digit code</label>
  <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" autocomplete="one-time-code" required ${input.lockedUntil || input.mode !== "full" ? "disabled" : ""}>
  <div class="actions">
    <button type="submit" ${input.lockedUntil || input.mode !== "full" ? "disabled" : ""}>Elevate</button>
    ${input.elevatedUntil ? html`<button type="submit" formaction="/elevate/drop" formnovalidate>Drop elevation</button>` : ""}
  </div>
</form>`;
}

/** Forms on the alert detail page that lead to previews. */
export function alertActionPanel(input: { alertId: string; status: string; mode: string }): SafeHtml {
  if (input.status === "resolved") return html`<p class="muted">Resolved; no further transition.</p>`;
  const previewBase = `/commands/alert.transition/preview`;
  return html`<h2>Actions</h2>
<div class="actions">
${
  input.status === "open"
    ? html`<form method="get" action="${previewBase}" class="inline">
  <input type="hidden" name="target" value="${input.alertId}">
  <input type="hidden" name="status" value="acknowledged">
  <button type="submit">Preview acknowledge…</button>
</form>`
    : ""
}
</div>
<form method="get" action="${previewBase}" class="stack">
  <input type="hidden" name="target" value="${input.alertId}">
  <input type="hidden" name="status" value="resolved">
  <label for="resolutionCode">Resolution code (lowercase, 3 to 80 characters, e.g. <code>refund_issued_in_dashboard</code>)</label>
  <input type="text" id="resolutionCode" name="resolutionCode" pattern="[a-z][a-z0-9_]{2,79}" required autocomplete="off">
  <div><button type="submit">Preview resolve…</button></div>
</form>
${input.mode !== "full" ? html`<p class="muted">Read-only mode: previews work, execution is refused.</p>` : ""}`;
}

/** Forms on the job detail page that lead to previews. */
export function jobActionPanel(input: { jobId: string; status: string; providerOutcome: string; mode: string }): SafeHtml {
  if (input.status === "held" && input.providerOutcome === "ambiguous") {
    return html`<h2>Resolve with provider evidence</h2>
<form method="get" action="/commands/job.resolve/preview" class="stack">
  <input type="hidden" name="target" value="${input.jobId}">
  <label for="decision">Decision</label>
  <select id="decision" name="decision" required>
    <option value="accepted">accepted: the provider shows the mail as created</option>
    <option value="retry">retry: the provider shows nothing; send again</option>
    <option value="rejected">rejected: the provider refused it; fail the letter</option>
  </select>
  <label for="providerName">Provider consulted</label>
  <select id="providerName" name="providerName" required>
    <option value="postgrid">postgrid</option>
    <option value="dummy">dummy</option>
    <option value="diy">diy</option>
  </select>
  <label for="providerTrackingId">Provider reference (required for accepted, empty otherwise)</label>
  <input type="text" id="providerTrackingId" name="providerTrackingId" autocomplete="off" maxlength="255">
  <div><button type="submit">Preview resolution…</button></div>
</form>
${input.mode !== "full" ? html`<p class="muted">Read-only mode: previews work, execution is refused.</p>` : ""}`;
  }
  if (input.status === "failed" && input.providerOutcome === "definite_failure") {
    return html`<h2>Retry</h2>
<form method="get" action="/commands/job.retry/preview" class="inline">
  <input type="hidden" name="target" value="${input.jobId}">
  <button type="submit">Preview retry…</button>
</form>
${input.mode !== "full" ? html`<p class="muted">Read-only mode: previews work, execution is refused.</p>` : ""}`;
  }
  return html``;
}

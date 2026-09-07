import type { ReservationView } from "../queries/images.js";
import { html, join, type SafeHtml } from "../ui/html.js";
import { statusBadge } from "../ui/format.js";
import { accountLink, table, when } from "./common.js";

export function renderImages(input: { reservations: ReservationView[]; mode: string }): SafeHtml {
  return html`<h1>Image generation recovery</h1>
<p class="muted">Reservations whose provider outcome is unknown. Each holds one generation against the customer's quota until an operator decides with provider evidence. Compensation grants live on the account page.</p>
${table(
  "Ambiguous reservations",
  ["Reservation", "Account", "Dispatch started", "Provider request", "Reason", "Updated", "Resolve"],
  input.reservations.map((reservation) => [
    html`<span class="mono">${reservation.reservationId}</span>`,
    accountLink(reservation.userId),
    when(reservation.dispatchStartedAt),
    html`${reservation.hasProviderRequestId ? "present" : "absent"}`,
    html`${reservation.resolutionReason ?? "—"}`,
    when(reservation.updatedAt),
    resolveForms(reservation.reservationId),
  ]),
  "none: every reservation has a known outcome.",
)}
${input.mode !== "full" ? html`<p class="muted">Read-only mode: previews work, execution is refused.</p>` : ""}
<p class="muted">Status legend: ${statusBadge("ambiguous")} awaits evidence; consume keeps the quota used, release returns it.</p>`;
}

function resolveForms(reservationId: string): SafeHtml {
  const options: Array<[string, string, string]> = [
    ["consume", "provider_confirmed_succeeded", "Consume (provider produced it)"],
    ["release", "provider_confirmed_failed", "Release (provider failed)"],
    ["release", "customer_compensation", "Release as compensation"],
  ];
  return join(
    options.map(
      ([decision, resolution, label]) => html`<form method="get" action="/commands/image.resolve/preview" class="inline">
  <input type="hidden" name="target" value="${reservationId}">
  <input type="hidden" name="decision" value="${decision}">
  <input type="hidden" name="resolution" value="${resolution}">
  <button type="submit">${label}…</button>
</form> `,
    ),
  );
}

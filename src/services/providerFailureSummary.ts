/**
 * The data-free form of a definite provider rejection, for the columns an
 * operator reads: letter_jobs.last_error, orders.last_error and the
 * provider.terminal_failure order event.
 *
 * Until 2026-09 the definite-rejection path stored the provider's message
 * verbatim. PostGrid's validation messages name the field and the value that
 * failed, so a rejected letter could leave a fragment of the recipient's
 * address in three columns the admin reader role can select and two pages
 * render (audit A-08). The ambiguous and exception paths already stored an
 * error class only; this brings the definite path in line while keeping the
 * one operational signal that matters, the HTTP status.
 *
 * Nothing from the message survives except a three-digit status, taken from
 * the provider's structured metadata when present and otherwise from the
 * `HTTP <status>` prefix the provider client puts on every message.
 *
 * One class of ours is kept as it is: a refusal before any request (#625), when
 * a letter asks for a service the provider cannot sell. It is not the
 * provider's answer, and an operator reading the column should not be told it
 * was.
 */
const REFUSAL_CLASSES: ReadonlySet<string> = new Set(['extra_service_refused']);

export function summarizeProviderRejection(result: {
  error?: string;
  metadata?: Record<string, unknown> | undefined;
}): string {
  const refusal = result.metadata?.errorClass;
  if (typeof refusal === 'string' && REFUSAL_CLASSES.has(refusal)) return refusal;
  const fromMetadata = result.metadata?.statusCode;
  const fromMessage = /^HTTP (\d{3})\b/.exec(result.error ?? '')?.[1];
  const status =
    typeof fromMetadata === 'number' && Number.isInteger(fromMetadata)
      ? fromMetadata
      : fromMessage
        ? Number(fromMessage)
        : undefined;
  return status === undefined ? 'provider_rejected' : `provider_rejected http_${status}`;
}

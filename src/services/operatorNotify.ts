import { operatorAlertUrl, operatorAlertUrlInvalid } from '../config/operatorAlerts.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

/**
 * Telling the operator (#699). Each notice is plain text posted to
 * LETTER_IRL_OPERATOR_ALERT_URL, such as an ntfy topic, which shows it on a
 * phone (src/config/operatorAlerts.ts). The admin panel's Alerts page has the
 * detail, so a notice names no customer, letter or order.
 *
 * Unset, nothing is posted; production requires it (src/config/deploymentConfig.ts).
 */

export type OperatorNoticeOutcome = 'sent' | 'skipped' | 'invalid' | 'failed';

/** What a notice is about: one is posted per kind per run (notifyOperator). */
export type OperatorNoticeKind =
  | 'missed_mail_day'
  | 'provider_cancelled'
  | 'ambiguous_outcome'
  | 'held_mail_funding'
  | 'refunded_mail_dispatched'
  | 'refund_not_completed';

export const OPERATOR_ALERT_TIMEOUT_MS = 10_000;

/**
 * How long one kind stays quiet after a notice: an hour. The maintenance run
 * is one process an hour, so it posts at most one of each kind a run; the
 * API, which runs for days, at most one of each kind an hour.
 */
export const OPERATOR_NOTICE_WINDOW_MS = 60 * 60 * 1000;

/** The Railway environment's name, to say which environment a notice is from. */
export function environmentName(env: NodeJS.ProcessEnv): string {
  return (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || '').trim().slice(0, 40);
}

/** "Letter IRL (production): " and the text. */
export function operatorNoticeText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const where = environmentName(env);
  return `Letter IRL${where ? ` (${where})` : ''}: ${text}`;
}

/** The diagnostics a sender writes, by its own names. */
export interface OperatorNoticeEvents {
  invalid: string;
  failed: string;
}

/**
 * Posts `body` as plain text. Never throws, and never logs the URL, which is
 * a capability.
 */
export async function postOperatorNotice(
  body: string,
  events: OperatorNoticeEvents,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = OPERATOR_ALERT_TIMEOUT_MS
): Promise<OperatorNoticeOutcome> {
  if (operatorAlertUrlInvalid(env)) {
    writeDiagnostic('warn', events.invalid);
    return 'invalid';
  }
  const url = operatorAlertUrl(env);
  if (!url) return 'skipped';
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      writeDiagnostic('warn', events.failed, { status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    const errorClass =
      name === 'TimeoutError' || name === 'AbortError'
        ? 'ETIMEDOUT'
        : classifyDiagnosticError((error as { cause?: unknown } | null)?.cause ?? error, 'provider_error');
    writeDiagnostic('warn', events.failed, { errorClass });
    return 'failed';
  }
}

/** When each kind last posted, in this process. */
const lastNotice = new Map<OperatorNoticeKind, number>();

export interface NotifyOperatorOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Tells the operator `text`, unless this kind was told within the last hour
 * (OPERATOR_NOTICE_WINDOW_MS), when it is left: 'repeat'. The first of a kind
 * holds the window whether or not its post succeeds, so an endpoint that is
 * down is not asked again for every letter. Never throws.
 */
export async function notifyOperator(
  kind: OperatorNoticeKind,
  text: string,
  options: NotifyOperatorOptions = {}
): Promise<OperatorNoticeOutcome | 'repeat'> {
  const env = options.env ?? process.env;
  const now = (options.now ?? Date.now)();
  const last = lastNotice.get(kind);
  if (last !== undefined && now - last < OPERATOR_NOTICE_WINDOW_MS) {
    writeDiagnostic('info', 'operator.notice_repeat', { kind });
    return 'repeat';
  }
  lastNotice.set(kind, now);
  const outcome = await postOperatorNotice(
    operatorNoticeText(text, env),
    { invalid: 'operator.alert_url_invalid', failed: 'operator.alert_failed' },
    env,
    options.fetchImpl ?? fetch,
    options.timeoutMs ?? OPERATOR_ALERT_TIMEOUT_MS
  );
  if (outcome === 'sent') writeDiagnostic('info', 'operator.notice_sent', { kind });
  return outcome;
}

/** The notices started without waiting (reportToOperator); each settles, never rejects. */
const inFlightNotices = new Set<Promise<unknown>>();

/**
 * notifyOperator without waiting, for a path that must not: a send's inline
 * dispatch, or a Stripe webhook inside its transaction. The maintenance run
 * waits for these before it exits, and the API, for a few seconds, before it
 * shuts down (settleOperatorNotices).
 */
export function reportToOperator(kind: OperatorNoticeKind, text: string, options: NotifyOperatorOptions = {}): void {
  const pending = notifyOperator(kind, text, options).catch(() => undefined);
  inFlightNotices.add(pending);
  void pending.finally(() => inFlightNotices.delete(pending));
}

/** Waits for every notice started so far, including any started while waiting. */
export async function settleOperatorNotices(): Promise<void> {
  while (inFlightNotices.size > 0) {
    await Promise.allSettled([...inFlightNotices]);
  }
}

/** Forgets which kinds were told, for tests. */
export function resetOperatorNoticesForTests(): void {
  lastNotice.clear();
}

/** The words for each kind. Counts only: the Alerts page has the rest. */
export const OPERATOR_NOTICES = {
  missedMailDay: (count: number) =>
    `${count === 1 ? '1 letter' : `${count} letters`} with an arrival date did not reach the printer by 18:00 New York time on ${count === 1 ? 'its' : 'their'} mail day. See the Alerts page on the admin panel.`,
  providerCancelled: (count: number) =>
    `The print provider cancelled ${count === 1 ? '1 letter' : `${count} letters`} before printing. A prepaid or gift letter's payment goes back on its own; a critical alert means a person must decide a refund. See the Alerts page on the admin panel.`,
  ambiguousOutcome: () =>
    'A letter was sent to the print provider and the outcome is unknown, so it may need checking with the provider. See the Alerts page on the admin panel.',
  refundedMailDispatched: () =>
    'A Pay & Send order was refunded or disputed after its letter went, or may have gone, to the print provider. A person must check it with the provider. See the Alerts page on the admin panel.',
  heldMailFunding: () =>
    'Mail paid for by a purchase that was refunded or disputed is held until a person sends or cancels it. See the Alerts page on the admin panel.',
  refundNotCompleted: () =>
    'A refund failed or was cancelled at Stripe, and the order waits for a person instead of being refunded again. Check its refunds and any dispute in Stripe before refunding it again. See the order page on the admin panel, linked from its alert on the Alerts page.'
} as const;

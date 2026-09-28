/**
 * Where the operator is told that something needs them: an https URL that
 * takes a plain-text POST (LETTER_IRL_OPERATOR_ALERT_URL). A healthchecks.io
 * check's `/fail` address emails its owner; push services such as ntfy show
 * the text on a phone. Like MAINTENANCE_HEARTBEAT_URL it is a capability, so
 * it is never logged. The first user is the daily limits (migration 038).
 */

/** The URL when it is https with no credentials in it, else null. */
export function operatorAlertUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.LETTER_IRL_OPERATOR_ALERT_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** True when the variable is set to something that is not such a URL. */
export function operatorAlertUrlInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LETTER_IRL_OPERATOR_ALERT_URL ?? '').trim() !== '' && operatorAlertUrl(env) === null;
}

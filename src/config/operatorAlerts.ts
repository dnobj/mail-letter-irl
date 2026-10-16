/**
 * Where the operator is told that something needs them: an https URL that
 * takes a plain-text POST (LETTER_IRL_OPERATOR_ALERT_URL), such as an ntfy
 * topic, which shows every notice on a phone. (A healthchecks.io `/fail`
 * address emails only when its check changes state, so it tells the first
 * notice and then nothing.) Like MAINTENANCE_HEARTBEAT_URL it is a capability,
 * so it is never logged. Its users: the daily limits (migration 038) and
 * src/services/operatorNotify.ts (#699).
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

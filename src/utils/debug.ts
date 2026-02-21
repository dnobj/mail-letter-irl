/**
 * DEBUG toggle helper.
 *
 * Defaults to false when unset.
 * Supports common truthy values and `letter-irl:*` style DEBUG strings.
 */
export function isDebugEnabled(raw: string | undefined = process.env.DEBUG): boolean {
  if (!raw) {
    return false;
  }

  const value = raw.trim().toLowerCase();
  if (!value) {
    return false;
  }

  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return value.includes("letter-irl") || value.includes("*");
}

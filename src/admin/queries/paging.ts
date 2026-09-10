/**
 * Keyset pagination helpers. Cursors are opaque to the page and carry the
 * last row's timestamp and id; the queries order by (timestamp DESC, id DESC)
 * and continue from strictly before the cursor.
 */

export interface Cursor {
  at: Date;
  id: string;
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value || value.length > 200) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) return null;
  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || !id || id.length > 255) return null;
  return { at, id };
}

export function boundedLimit(value: unknown, fallback = 25, max = 100): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

/** Fetch limit+1 rows, return limit and the cursor for the rest. */
export function toPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
): Page<T> {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const kept = rows.slice(0, limit);
  return { rows: kept, nextCursor: cursorOf(kept[kept.length - 1]) };
}

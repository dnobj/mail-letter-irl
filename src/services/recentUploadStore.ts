import { query } from "../db/index.js";
import { positiveIntegerSetting } from "../utils/envSettings.js";

/**
 * The most recent image each user uploaded through the upload widget, so a
 * preview tool can still find it when ChatGPT did not pass the URL along.
 *
 * The URL is a capability URL for the customer's own photo, so it must not
 * outlive its use (#282). Three rules bound it, and they only work together:
 *   - reads return a row for at most the TTL, which is capped at
 *     RECENT_UPLOAD_TTL_MAX_MS whatever the setting says;
 *   - purgeExpiredRecentUploads deletes a row RECENT_UPLOAD_PURGE_AFTER_HOURS
 *     after its last update, which is longer than any TTL, so a row a read
 *     could still return is never deleted;
 *   - the in-process Map drops expired entries on every call and on a timer,
 *     so the URL does not linger in memory either.
 */

interface RecentUploadRecord {
  imageUrl: string;
  context?: string;
  storedAtMs: number;
}

const RECENT_UPLOADS = new Map<string, RecentUploadRecord>();

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;

/**
 * The longest read window the setting may choose. It must stay below the purge
 * age: the API and maintenance services read their settings separately, so
 * this cap in code is what guarantees a readable row is never deletable.
 */
export const RECENT_UPLOAD_TTL_MAX_MS = 6 * 60 * 60 * 1000;

/** A row is deleted this long after its last update. */
export const RECENT_UPLOAD_PURGE_AFTER_HOURS = 24;

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The read window in milliseconds. Unparseable, truncated or out-of-range
 * values fall back to the default. This used to be `Number(...)`, and
 * `Number('abc')` is NaN while `ageMs > NaN` is never true, so a typo in the
 * setting meant cached URLs never expired.
 */
export function recentUploadTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntegerSetting(
    "LETTER_IRL_RECENT_UPLOAD_TTL_MS",
    DEFAULT_TTL_MS,
    MIN_TTL_MS,
    RECENT_UPLOAD_TTL_MAX_MS,
    env
  );
}

/** Returns true if the stored context matches the expected context. */
function matchContext(storedContext: string | undefined, expectedContext: string | undefined): boolean {
  if (!expectedContext) return true;
  if (!storedContext) return true;
  return storedContext === expectedContext;
}

/**
 * Drop every Map entry older than the TTL. It uses the same `>` comparison as
 * the read, so it never removes an entry a read would still return.
 */
export function pruneExpiredRecentUploads(nowMs: number = Date.now()): void {
  const ttlMs = recentUploadTtlMs();
  for (const [userId, record] of RECENT_UPLOADS) {
    if (nowMs - record.storedAtMs > ttlMs) RECENT_UPLOADS.delete(userId);
  }
}

/**
 * Started by the first upload rather than at import: the maintenance command
 * and the test suites import this module, and neither should gain a timer.
 * unref() keeps housekeeping from holding a process open.
 */
function ensurePruneTimer(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => pruneExpiredRecentUploads(), PRUNE_INTERVAL_MS);
  (pruneTimer as unknown as { unref?: () => void }).unref?.();
}

export async function setRecentUploadedImage(
  userId: string,
  imageUrl: string,
  context?: string
): Promise<void> {
  pruneExpiredRecentUploads();
  RECENT_UPLOADS.set(userId, {
    imageUrl,
    context,
    storedAtMs: Date.now()
  });
  ensurePruneTimer();

  try {
    await query(
      `INSERT INTO recent_uploads (user_id, image_url, context)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET image_url  = EXCLUDED.image_url,
             context    = EXCLUDED.context,
             updated_at = NOW()`,
      [userId, imageUrl, context ?? null]
    );
  } catch (err) {
    // DB write is best-effort — in-memory store is the primary fast path
    console.error("recentUploadStore: DB write failed");
  }
}

export async function getRecentUploadedImage(
  userId: string,
  expectedContext?: string
): Promise<{ imageUrl: string; context?: string; ageMs: number } | null> {
  pruneExpiredRecentUploads();
  const ttlMs = recentUploadTtlMs();

  // Fast path: check in-memory cache first
  const cached = RECENT_UPLOADS.get(userId);
  if (cached) {
    const ageMs = Date.now() - cached.storedAtMs;
    if (ageMs > ttlMs) {
      RECENT_UPLOADS.delete(userId);
    } else if (matchContext(cached.context, expectedContext)) {
      return { imageUrl: cached.imageUrl, context: cached.context, ageMs };
    }
  }

  // Slow path: fall back to DB. The window is the same TTL as the Map's, so
  // the two paths cannot disagree about whether an upload is still usable.
  try {
    const result = await query<{ image_url: string; context: string | null; updated_at: Date }>(
      `SELECT image_url, context, updated_at
       FROM recent_uploads
       WHERE user_id = $1
         AND updated_at > NOW() - make_interval(secs => $2::double precision)`,
      [userId, ttlMs / 1000]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const updatedAt = new Date(row.updated_at).getTime();
    const ageMs = Date.now() - updatedAt;

    // Double-check TTL in TypeScript (clock skew safety)
    if (ageMs > ttlMs) return null;

    if (!matchContext(row.context ?? undefined, expectedContext)) return null;

    // Backfill in-memory cache
    RECENT_UPLOADS.set(userId, {
      imageUrl: row.image_url,
      context: row.context ?? undefined,
      storedAtMs: updatedAt
    });

    return {
      imageUrl: row.image_url,
      context: row.context ?? undefined,
      ageMs
    };
  } catch (err) {
    console.error("recentUploadStore: DB read failed");
    return null;
  }
}

/**
 * Delete upload rows RECENT_UPLOAD_PURGE_AFTER_HOURS after their last update
 * (#282). A read stops returning a row at the TTL, which is capped below this,
 * so no row a read could still return is deleted.
 *
 * Deliberately the simplest statement possible: one table, one time rule, no
 * joins and no batching. There is at most one row per user, and nothing
 * references the table. It returns a count; callers log the count, never a URL.
 */
export async function purgeExpiredRecentUploads(): Promise<number> {
  const result = await query(
    `DELETE FROM recent_uploads
      WHERE updated_at < NOW() - make_interval(hours => $1::int)`,
    [RECENT_UPLOAD_PURGE_AFTER_HOURS]
  );
  return result.rowCount ?? 0;
}

/** How many uploads the in-process Map holds. For tests and diagnostics. */
export function getRecentUploadCount(): number {
  return RECENT_UPLOADS.size;
}

export function clearRecentUploadedImages(): void {
  RECENT_UPLOADS.clear();
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

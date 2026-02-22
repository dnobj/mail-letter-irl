import { query } from "../db/index.js";

interface RecentUploadRecord {
  imageUrl: string;
  context?: string;
  storedAtMs: number;
}

const RECENT_UPLOADS = new Map<string, RecentUploadRecord>();
const MAX_AGE_MS = Number(process.env.LETTER_IRL_RECENT_UPLOAD_TTL_MS ?? "3600000"); // 1 hour

/** Returns true if the stored context matches the expected context. */
function matchContext(storedContext: string | undefined, expectedContext: string | undefined): boolean {
  if (!expectedContext) return true;
  if (!storedContext) return true;
  return storedContext === expectedContext;
}

export async function setRecentUploadedImage(
  userId: string,
  imageUrl: string,
  context?: string
): Promise<void> {
  RECENT_UPLOADS.set(userId, {
    imageUrl,
    context,
    storedAtMs: Date.now()
  });

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
    console.error("recentUploadStore: DB write failed", err);
  }
}

export async function getRecentUploadedImage(
  userId: string,
  expectedContext?: string
): Promise<{ imageUrl: string; context?: string; ageMs: number } | null> {
  // Fast path: check in-memory cache first
  const cached = RECENT_UPLOADS.get(userId);
  if (cached) {
    const ageMs = Date.now() - cached.storedAtMs;
    if (ageMs > MAX_AGE_MS) {
      RECENT_UPLOADS.delete(userId);
    } else if (matchContext(cached.context, expectedContext)) {
      return { imageUrl: cached.imageUrl, context: cached.context, ageMs };
    }
  }

  // Slow path: fall back to DB
  try {
    const result = await query<{ image_url: string; context: string | null; updated_at: Date }>(
      `SELECT image_url, context, updated_at
       FROM recent_uploads
       WHERE user_id = $1
         AND updated_at > NOW() - INTERVAL '1 hour'`,
      [userId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const updatedAt = new Date(row.updated_at).getTime();
    const ageMs = Date.now() - updatedAt;

    // Double-check TTL in TypeScript (clock skew safety)
    if (ageMs > MAX_AGE_MS) return null;

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
    console.error("recentUploadStore: DB read failed", err);
    return null;
  }
}

export function clearRecentUploadedImages(): void {
  RECENT_UPLOADS.clear();
}

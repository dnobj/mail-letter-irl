interface RecentUploadRecord {
  imageUrl: string;
  context?: string;
  storedAtMs: number;
}

const RECENT_UPLOADS = new Map<string, RecentUploadRecord>();
const MAX_AGE_MS = Number(process.env.LETTER_IRL_RECENT_UPLOAD_TTL_MS ?? "3600000"); // 1 hour

export function setRecentUploadedImage(
  userId: string,
  imageUrl: string,
  context?: string
): void {
  RECENT_UPLOADS.set(userId, {
    imageUrl,
    context,
    storedAtMs: Date.now()
  });
}

export function getRecentUploadedImage(
  userId: string,
  expectedContext?: string
): { imageUrl: string; context?: string; ageMs: number } | null {
  const record = RECENT_UPLOADS.get(userId);
  if (!record) {
    return null;
  }

  const ageMs = Date.now() - record.storedAtMs;
  if (ageMs > MAX_AGE_MS) {
    RECENT_UPLOADS.delete(userId);
    return null;
  }

  // If caller wants a specific context, enforce a match when the stored
  // record has context set.
  if (
    expectedContext &&
    record.context &&
    record.context !== expectedContext
  ) {
    return null;
  }

  return {
    imageUrl: record.imageUrl,
    context: record.context,
    ageMs
  };
}

export function clearRecentUploadedImages(): void {
  RECENT_UPLOADS.clear();
}


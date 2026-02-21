/**
 * Temporary Image Store
 *
 * In-memory cache for generated images. Stores the full-resolution base64
 * image data temporarily so it can be served via HTTP when the preview tool
 * downloads it.
 *
 * Images auto-expire after 15 minutes. This is sufficient for the typical
 * flow: generate → preview → confirm (~1-5 minutes).
 */

import { randomBytes } from "crypto";

// ============================================================================
// Configuration
// ============================================================================

const TTL_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute

// ============================================================================
// Store
// ============================================================================

interface StoredImage {
  base64Data: string;
  expiresAt: number;
}

const store = new Map<string, StoredImage>();

// Periodic cleanup of expired entries
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(token);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Don't prevent process exit
cleanupTimer.unref();

// ============================================================================
// Public API
// ============================================================================

/**
 * Store a base64 image and return a retrieval token.
 */
export function storeImage(base64Data: string): string {
  const token = randomBytes(16).toString("hex");
  store.set(token, {
    base64Data,
    expiresAt: Date.now() + TTL_MS
  });
  return token;
}

/**
 * Retrieve a stored image by token. Returns null if not found or expired.
 * Does NOT delete the entry (image may be fetched multiple times).
 */
export function getImage(token: string): string | null {
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(token);
    return null;
  }
  return entry.base64Data;
}

/**
 * Get current store size (for monitoring/logging).
 */
export function getStoreSize(): number {
  return store.size;
}

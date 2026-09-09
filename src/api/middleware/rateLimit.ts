/**
 * Rate Limiting Middleware
 *
 * In-memory rate limiter with configurable limits per endpoint type.
 * Uses sliding window algorithm for accurate rate limiting.
 *
 * Note: For production with multiple instances, consider Redis-based rate limiting.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { getCachedUserTier, getTierMultiplier } from '../../services/tierService.js';
import type { UserTier } from '../../services/types.js';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Maximum requests per window
}

// In-memory store for rate limit tracking
// Key format: `${identifier}:${endpoint}` or `global:${endpoint}` for global limits
const rateLimitStore = new Map<string, RateLimitEntry>();

// Track blocked request counts for monitoring
const blockedRequestCounts = new Map<string, number>();

// Global rate limit configuration (system-wide, not per-IP)
const GLOBAL_RATE_LIMITS: Record<string, RateLimitConfig> = {
  'promo_public': {
    windowMs: 60 * 1000,      // 1 minute
    maxRequests: 100,         // 100 total per minute (protects against distributed attacks)
  },
  // Backstops for the routes that had only per-identifier limits (audit A-05).
  // A per-identifier limit bounds one client; these bound everyone at once, so
  // many addresses cannot burn JWKS verification or bcrypt compares at line
  // rate. Each is twenty times the per-identifier limit: far above any traffic
  // this service has seen, so a hit is an incident rather than a busy day.
  'mcp': {
    windowMs: 60 * 1000,
    maxRequests: 1200,
  },
  'api': {
    windowMs: 60 * 1000,
    maxRequests: 2000,
  },
  'checkout': {
    windowMs: 60 * 1000,
    maxRequests: 200,
  },
};

// Cleanup interval to prevent memory leaks (run every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// Rate limit configurations by endpoint type
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Authentication endpoints - strict limits to prevent brute force
  'auth': {
    windowMs: 60 * 1000,     // 1 minute
    maxRequests: 10,          // 10 requests per minute
  },
  // Send letter - prevent spam/abuse
  'send_letter': {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 20,          // 20 letters per hour
  },
  // General API endpoints
  'api': {
    windowMs: 60 * 1000,      // 1 minute
    maxRequests: 100,         // 100 requests per minute
  },
  // Stripe checkout - prevent abuse
  'checkout': {
    windowMs: 60 * 1000,      // 1 minute
    maxRequests: 10,          // 10 checkout attempts per minute
  },
  // Admin API - moderate limits
  'admin': {
    windowMs: 60 * 1000,      // 1 minute
    maxRequests: 50,          // 50 requests per minute
  },
  // MCP tool calls
  'mcp': {
    windowMs: 60 * 1000,      // 1 minute
    maxRequests: 60,          // 60 tool calls per minute
  },
  // Public promo code validation - prevent brute force enumeration
  'promo_public': {
    windowMs: 60 * 1000,      // 1 minute
    maxRequests: 10,          // 10 per minute per IP (generous for legitimate use)
  },
};

/**
 * The identifier a per-address rate limit keys on.
 *
 * The LAST X-Forwarded-For hop, never the first. The first hop is whatever
 * the client wrote; the last is what the edge in front of this service
 * appended when it forwarded the request. Verified against Railway's edge on
 * 2026-09-08: a client-supplied value did not reach the first position (the
 * edge sets the header itself), so on that edge first and last are the same
 * address today. Taking the last hop keeps the limit honest whether an edge
 * appends to the header or replaces it, which is one less thing the edge's
 * behaviour has to be trusted for (audit A-05). Falls back to the socket
 * address when no header is present, which is the direct-connection case.
 */
export function getClientIdentifier(req: IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    // Several header lines arrive as an array; the last line was added last.
    const raw = Array.isArray(forwardedFor) ? forwardedFor[forwardedFor.length - 1] : forwardedFor;
    const hops = raw.split(',').map((hop) => hop.trim()).filter((hop) => hop.length > 0);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Get user identifier if authenticated
 * This provides per-user rate limiting for authenticated requests
 */
function getUserIdentifier(req: IncomingMessage): string | null {
  // Check if auth info was attached by authentication middleware
  const authInfo = (req as any).auth;
  return authInfo?.userId || null;
}

/**
 * Check and update rate limit for a request
 *
 * @returns Object with allowed boolean and limit info
 */
export function checkRateLimit(
  req: IncomingMessage,
  endpointType: keyof typeof RATE_LIMITS
): {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
} {
  const config = RATE_LIMITS[endpointType] || RATE_LIMITS['api'];
  const now = Date.now();

  // Use user ID if authenticated, otherwise use IP
  const userId = getUserIdentifier(req);
  const clientIp = getClientIdentifier(req);
  const identifier = userId || clientIp;
  const key = `${identifier}:${endpointType}`;

  // Get or create rate limit entry
  let entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart >= config.windowMs) {
    // Start new window
    entry = {
      count: 1,
      windowStart: now,
    };
    rateLimitStore.set(key, entry);

    return {
      allowed: true,
      limit: config.maxRequests,
      remaining: config.maxRequests - 1,
      resetMs: config.windowMs,
    };
  }

  // Check if within limits
  if (entry.count >= config.maxRequests) {
    const resetMs = config.windowMs - (now - entry.windowStart);
    return {
      allowed: false,
      limit: config.maxRequests,
      remaining: 0,
      resetMs,
    };
  }

  // Increment counter
  entry.count++;

  return {
    allowed: true,
    limit: config.maxRequests,
    remaining: config.maxRequests - entry.count,
    resetMs: config.windowMs - (now - entry.windowStart),
  };
}

/**
 * Rate limit middleware that sends 429 response if limit exceeded
 *
 * @returns true if request was blocked (response already sent), false otherwise
 */
export function rateLimitMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  endpointType: keyof typeof RATE_LIMITS
): boolean {
  const result = checkRateLimit(req, endpointType);

  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetMs / 1000));

  if (!result.allowed) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', Math.ceil(result.resetMs / 1000));
    res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please wait ${Math.ceil(result.resetMs / 1000)} seconds before retrying.`,
      retryAfter: Math.ceil(result.resetMs / 1000),
    }));
    return true; // Request was blocked
  }

  return false; // Request allowed
}

/**
 * Cleanup expired entries to prevent memory leaks
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  const maxWindowMs = Math.max(...Object.values(RATE_LIMITS).map(c => c.windowMs));

  // Use Array.from for ES5 compatibility
  const entries = Array.from(rateLimitStore.entries());
  for (const [key, entry] of entries) {
    if (now - entry.windowStart > maxWindowMs * 2) {
      rateLimitStore.delete(key);
    }
  }
}

// Start cleanup interval
setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);

/**
 * Get current rate limit stats (for monitoring/debugging)
 */
export function getRateLimitStats(): {
  totalEntries: number;
  entriesByType: Record<string, number>;
} {
  const entriesByType: Record<string, number> = {};

  // Use Array.from for ES5 compatibility
  const keys = Array.from(rateLimitStore.keys());
  for (const key of keys) {
    const type = key.split(':')[1] || 'unknown';
    entriesByType[type] = (entriesByType[type] || 0) + 1;
  }

  return {
    totalEntries: rateLimitStore.size,
    entriesByType,
  };
}

// ============================================================================
// Tier-Aware Rate Limiting (Async)
// ============================================================================

/**
 * Get effective rate limit for a tier and endpoint.
 * Returns the adjusted maxRequests based on tier multipliers.
 */
export function getEffectiveRateLimit(
  endpointType: keyof typeof RATE_LIMITS,
  tier: UserTier = 'standard'
): number {
  const config = RATE_LIMITS[endpointType] || RATE_LIMITS['api'];
  const multiplier = getTierMultiplier(tier, endpointType);
  return Math.floor(config.maxRequests * multiplier);
}

/**
 * Check rate limit with tier awareness (async).
 * This is the preferred function for authenticated endpoints.
 */
export async function checkRateLimitWithTier(
  req: IncomingMessage,
  endpointType: keyof typeof RATE_LIMITS
): Promise<{
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  tier: UserTier;
}> {
  const config = RATE_LIMITS[endpointType] || RATE_LIMITS['api'];
  const now = Date.now();

  // Get user identifier and tier
  const userId = getUserIdentifier(req);
  const clientIp = getClientIdentifier(req);
  const identifier = userId || clientIp;

  // Look up tier for authenticated users
  let tier: UserTier = 'standard';
  if (userId) {
    try {
      tier = await getCachedUserTier(userId);
    } catch {
      console.warn('Failed to get account tier');
    }
  }

  // Calculate effective rate limit based on tier
  const effectiveMaxRequests = getEffectiveRateLimit(endpointType, tier);
  const key = `${identifier}:${endpointType}`;

  // Get or create rate limit entry
  let entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart >= config.windowMs) {
    entry = { count: 1, windowStart: now };
    rateLimitStore.set(key, entry);
    return {
      allowed: true,
      limit: effectiveMaxRequests,
      remaining: effectiveMaxRequests - 1,
      resetMs: config.windowMs,
      tier,
    };
  }

  if (entry.count >= effectiveMaxRequests) {
    return {
      allowed: false,
      limit: effectiveMaxRequests,
      remaining: 0,
      resetMs: config.windowMs - (now - entry.windowStart),
      tier,
    };
  }

  entry.count++;
  return {
    allowed: true,
    limit: effectiveMaxRequests,
    remaining: effectiveMaxRequests - entry.count,
    resetMs: config.windowMs - (now - entry.windowStart),
    tier,
  };
}

/**
 * Rate limit middleware with tier awareness (async).
 * @returns true if request was blocked, false otherwise
 */
export async function rateLimitMiddlewareWithTier(
  req: IncomingMessage,
  res: ServerResponse,
  endpointType: keyof typeof RATE_LIMITS
): Promise<boolean> {
  const result = await checkRateLimitWithTier(req, endpointType);

  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetMs / 1000));
  res.setHeader('X-RateLimit-Tier', result.tier);

  if (!result.allowed) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', Math.ceil(result.resetMs / 1000));
    res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please wait ${Math.ceil(result.resetMs / 1000)} seconds before retrying.`,
      retryAfter: Math.ceil(result.resetMs / 1000),
      tier: result.tier,
    }));
    return true;
  }

  // The per-identifier limit above bounds one client. Routes with a global
  // entry also refuse at that ceiling whatever the mix of identifiers.
  const globalResult = checkGlobalRateLimit(endpointType);
  if (!globalResult.allowed) {
    console.warn(`⚠️ Rate limit hit (global): ${endpointType} - system-wide limit reached`);
    incrementBlockedCount(endpointType, 'global');
    res.setHeader('X-RateLimit-Limit', globalResult.limit);
    res.setHeader('X-RateLimit-Remaining', 0);
    res.setHeader('X-RateLimit-Reset', Math.ceil(globalResult.resetMs / 1000));
    res.setHeader('X-RateLimit-Scope', 'global');
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', Math.ceil(globalResult.resetMs / 1000));
    res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please wait ${Math.ceil(globalResult.resetMs / 1000)} seconds before retrying.`,
      retryAfter: Math.ceil(globalResult.resetMs / 1000),
      tier: result.tier,
    }));
    return true;
  }

  return false;
}

// ============================================================================
// Global Rate Limiting (System-Wide)
// ============================================================================

/**
 * Check global rate limit for an endpoint type.
 * This is system-wide, not per-IP.
 */
export function checkGlobalRateLimit(
  endpointType: string
): {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
} {
  const config = GLOBAL_RATE_LIMITS[endpointType];
  if (!config) {
    // No global limit configured for this endpoint
    return { allowed: true, limit: 0, remaining: 0, resetMs: 0 };
  }

  const now = Date.now();
  const key = `global:${endpointType}`;

  let entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart >= config.windowMs) {
    entry = { count: 1, windowStart: now };
    rateLimitStore.set(key, entry);
    return {
      allowed: true,
      limit: config.maxRequests,
      remaining: config.maxRequests - 1,
      resetMs: config.windowMs,
    };
  }

  if (entry.count >= config.maxRequests) {
    return {
      allowed: false,
      limit: config.maxRequests,
      remaining: 0,
      resetMs: config.windowMs - (now - entry.windowStart),
    };
  }

  entry.count++;
  return {
    allowed: true,
    limit: config.maxRequests,
    remaining: config.maxRequests - entry.count,
    resetMs: config.windowMs - (now - entry.windowStart),
  };
}

/**
 * Increment blocked request counter for monitoring
 */
function incrementBlockedCount(endpointType: string, reason: 'ip' | 'global'): void {
  const key = `${endpointType}:${reason}`;
  const current = blockedRequestCounts.get(key) || 0;
  blockedRequestCounts.set(key, current + 1);
}

/**
 * Rate limit middleware with both per-IP and global limits.
 * Use this for public endpoints that need protection against distributed attacks.
 *
 * @returns true if request was blocked (response already sent), false otherwise
 */
export function rateLimitMiddlewareWithGlobal(
  req: IncomingMessage,
  res: ServerResponse,
  endpointType: keyof typeof RATE_LIMITS
): boolean {
  // Check per-IP first (fast rejection of individual abusers)
  const ipResult = checkRateLimit(req, endpointType);

  if (!ipResult.allowed) {
    const clientIp = getClientIdentifier(req);
    console.warn(`⚠️ Rate limit hit (IP scope) on ${endpointType}`);
    incrementBlockedCount(endpointType, 'ip');

    res.setHeader('X-RateLimit-Limit', ipResult.limit);
    res.setHeader('X-RateLimit-Remaining', 0);
    res.setHeader('X-RateLimit-Reset', Math.ceil(ipResult.resetMs / 1000));
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', Math.ceil(ipResult.resetMs / 1000));
    res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please wait ${Math.ceil(ipResult.resetMs / 1000)} seconds before retrying.`,
      retryAfter: Math.ceil(ipResult.resetMs / 1000),
    }));
    return true;
  }

  // Check global limit (protects against distributed attacks)
  const globalResult = checkGlobalRateLimit(endpointType);

  if (!globalResult.allowed) {
    console.warn(`⚠️ Rate limit hit (global): ${endpointType} - system-wide limit reached`);
    incrementBlockedCount(endpointType, 'global');

    res.setHeader('X-RateLimit-Limit', globalResult.limit);
    res.setHeader('X-RateLimit-Remaining', 0);
    res.setHeader('X-RateLimit-Reset', Math.ceil(globalResult.resetMs / 1000));
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', Math.ceil(globalResult.resetMs / 1000));
    res.end(JSON.stringify({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please wait ${Math.ceil(globalResult.resetMs / 1000)} seconds before retrying.`,
      retryAfter: Math.ceil(globalResult.resetMs / 1000),
    }));
    return true;
  }

  // Both checks passed - set headers based on per-IP limit (more relevant to user)
  res.setHeader('X-RateLimit-Limit', ipResult.limit);
  res.setHeader('X-RateLimit-Remaining', ipResult.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(ipResult.resetMs / 1000));

  return false;
}

/**
 * Get blocked request counts for monitoring
 */
export function getBlockedRequestCounts(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, count] of blockedRequestCounts.entries()) {
    result[key] = count;
  }
  return result;
}

/**
 * Reset blocked request counts (useful for testing)
 */
export function resetBlockedRequestCounts(): void {
  blockedRequestCounts.clear();
}

/**
 * Clear all rate limit state (useful for testing)
 */
export function clearRateLimitState(): void {
  rateLimitStore.clear();
  blockedRequestCounts.clear();
}

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
// Key format: `${identifier}:${endpoint}`
const rateLimitStore = new Map<string, RateLimitEntry>();

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
};

/**
 * Get client identifier from request
 * Uses X-Forwarded-For for proxied requests, falls back to socket address
 */
function getClientIdentifier(req: IncomingMessage): string {
  // Check for forwarded IP (from reverse proxy)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    // Take the first IP (original client)
    return ips.split(',')[0].trim();
  }

  // Fall back to direct connection IP
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
    } catch (error) {
      console.warn(`Failed to get tier for user ${userId}:`, error);
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

  return false;
}

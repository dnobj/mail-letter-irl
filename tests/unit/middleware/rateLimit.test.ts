/**
 * Unit tests for rate limiting middleware
 *
 * Tests the rate limiting functionality including:
 * - Per-IP rate limiting for promo_public endpoint
 * - Global (system-wide) rate limiting
 * - Combined middleware behavior
 * - Rate limit headers and response format
 * - Window reset behavior
 *
 * User Stories Covered:
 * - US-SEC-05: Rate Limiting (per-user, tier-based, 429 response)
 * - Issue #4: Add rate limiting to promo code validation endpoint
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  checkRateLimit,
  checkGlobalRateLimit,
  rateLimitMiddlewareWithGlobal,
  getBlockedRequestCounts,
  clearRateLimitState,
  RATE_LIMITS,
} from '../../../src/api/middleware/rateLimit.js';

// Helper to create mock request
function createMockRequest(ip: string = '127.0.0.1'): IncomingMessage {
  return {
    headers: {
      'x-forwarded-for': ip,
    },
    socket: {
      remoteAddress: ip,
    },
  } as unknown as IncomingMessage;
}

// Helper to create mock response
function createMockResponse(): ServerResponse & {
  _statusCode: number;
  _headers: Record<string, string | number>;
  _body: string;
} {
  const headers: Record<string, string | number> = {};
  const res = {
    _statusCode: 200,
    _headers: headers,
    _body: '',
    statusCode: 200,
    setHeader: function (name: string, value: string | number) {
      this._headers[name.toLowerCase()] = value;
    },
    end: function (body?: string) {
      this._body = body || '';
    },
  };
  Object.defineProperty(res, 'statusCode', {
    get() {
      return this._statusCode;
    },
    set(value: number) {
      this._statusCode = value;
    },
  });
  return res as any;
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    // Clear all rate limit state before each test
    clearRateLimitState();
  });

  afterEach(() => {
    clearRateLimitState();
  });

  // ==========================================================================
  // Configuration Tests
  // ==========================================================================
  describe('RATE_LIMITS configuration', () => {
    it('should have promo_public rate limit configured', () => {
      expect(RATE_LIMITS['promo_public']).toBeDefined();
      expect(RATE_LIMITS['promo_public'].windowMs).toBe(60 * 1000);
      expect(RATE_LIMITS['promo_public'].maxRequests).toBe(10);
    });
  });

  // ==========================================================================
  // Per-IP Rate Limiting Tests
  // ==========================================================================
  describe('checkRateLimit (per-IP)', () => {
    it('should allow requests within the limit', () => {
      const req = createMockRequest('192.168.1.1');

      for (let i = 0; i < 10; i++) {
        const result = checkRateLimit(req, 'promo_public');
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(10);
        expect(result.remaining).toBe(10 - (i + 1));
      }
    });

    it('should block the 11th request from the same IP', () => {
      const req = createMockRequest('192.168.1.2');

      // Make 10 allowed requests
      for (let i = 0; i < 10; i++) {
        const result = checkRateLimit(req, 'promo_public');
        expect(result.allowed).toBe(true);
      }

      // 11th request should be blocked
      const result = checkRateLimit(req, 'promo_public');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.resetMs).toBeGreaterThan(0);
      expect(result.resetMs).toBeLessThanOrEqual(60000);
    });

    it('should track different IPs separately', () => {
      const req1 = createMockRequest('10.0.0.1');
      const req2 = createMockRequest('10.0.0.2');

      // Exhaust limit for IP 1
      for (let i = 0; i < 10; i++) {
        checkRateLimit(req1, 'promo_public');
      }
      expect(checkRateLimit(req1, 'promo_public').allowed).toBe(false);

      // IP 2 should still have full quota
      const result = checkRateLimit(req2, 'promo_public');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
    });
  });

  // ==========================================================================
  // Global Rate Limiting Tests
  // ==========================================================================
  describe('checkGlobalRateLimit', () => {
    it('should allow requests within the global limit', () => {
      // Global limit for promo_public is 100
      for (let i = 0; i < 50; i++) {
        const result = checkGlobalRateLimit('promo_public');
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(100);
      }
    });

    it('should block requests exceeding global limit', () => {
      // Make 100 requests (the global limit)
      for (let i = 0; i < 100; i++) {
        const result = checkGlobalRateLimit('promo_public');
        expect(result.allowed).toBe(true);
      }

      // 101st request should be blocked
      const result = checkGlobalRateLimit('promo_public');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should return allowed=true with limit=0 for endpoints without global config', () => {
      const result = checkGlobalRateLimit('api');
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(0);
    });
  });

  // ==========================================================================
  // Combined Middleware Tests
  // ==========================================================================
  describe('rateLimitMiddlewareWithGlobal', () => {
    it('should return false (allowed) when under both limits', () => {
      const req = createMockRequest('172.16.0.1');
      const res = createMockResponse();

      const blocked = rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      expect(blocked).toBe(false);
      expect(res._statusCode).toBe(200);
      expect(res._headers['x-ratelimit-limit']).toBe(10);
      expect(res._headers['x-ratelimit-remaining']).toBe(9);
      expect(res._headers['x-ratelimit-reset']).toBeDefined();
    });

    it('should return true (blocked) and send 429 when IP limit exceeded', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const req = createMockRequest('172.16.0.2');
      const res = createMockResponse();

      // Exhaust per-IP limit
      for (let i = 0; i < 10; i++) {
        const tempRes = createMockResponse();
        rateLimitMiddlewareWithGlobal(req, tempRes, 'promo_public');
      }

      // Next request should be blocked
      const blocked = rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      expect(blocked).toBe(true);
      expect(res._statusCode).toBe(429);
      expect(res._headers['content-type']).toBe('application/json');
      expect(res._headers['retry-after']).toBeDefined();

      const body = JSON.parse(res._body);
      expect(body.error).toBe('Too Many Requests');
      expect(body.retryAfter).toBeGreaterThan(0);
      const logged = warn.mock.calls.flat().map(String).join('\n');
      expect(logged).toContain('Rate limit hit (IP scope)');
      expect(logged).not.toContain('172.16.0.2');
    });

    it('should return true (blocked) when global limit exceeded even if IP limit OK', () => {
      // Use different IPs to not hit per-IP limit, but exhaust global limit
      for (let i = 0; i < 100; i++) {
        const req = createMockRequest(`192.168.${Math.floor(i / 10)}.${i % 10}`);
        const res = createMockResponse();
        rateLimitMiddlewareWithGlobal(req, res, 'promo_public');
      }

      // New IP should be blocked by global limit
      const req = createMockRequest('10.10.10.10');
      const res = createMockResponse();
      const blocked = rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      expect(blocked).toBe(true);
      expect(res._statusCode).toBe(429);
    });

    it('should track blocked requests for monitoring', () => {
      const req = createMockRequest('172.16.0.3');

      // Exhaust per-IP limit
      for (let i = 0; i < 10; i++) {
        const res = createMockResponse();
        rateLimitMiddlewareWithGlobal(req, res, 'promo_public');
      }

      // Trigger blocked request
      const res = createMockResponse();
      rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      const blockedCounts = getBlockedRequestCounts();
      expect(blockedCounts['promo_public:ip']).toBe(1);
    });
  });

  // ==========================================================================
  // Response Format Tests
  // ==========================================================================
  describe('response format', () => {
    it('should include correct rate limit headers on success', () => {
      const req = createMockRequest('192.168.100.1');
      const res = createMockResponse();

      rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      expect(res._headers['x-ratelimit-limit']).toBe(10);
      expect(res._headers['x-ratelimit-remaining']).toBe(9);
      expect(res._headers['x-ratelimit-reset']).toBeGreaterThan(0);
    });

    it('should include Retry-After header on 429 response', () => {
      const req = createMockRequest('192.168.100.2');

      // Exhaust limit
      for (let i = 0; i < 10; i++) {
        const res = createMockResponse();
        rateLimitMiddlewareWithGlobal(req, res, 'promo_public');
      }

      const res = createMockResponse();
      rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      expect(res._statusCode).toBe(429);
      expect(res._headers['retry-after']).toBeDefined();
      expect(res._headers['retry-after']).toBeGreaterThan(0);
      expect(res._headers['retry-after']).toBeLessThanOrEqual(60);
    });

    it('should return valid JSON body on 429 response', () => {
      const req = createMockRequest('192.168.100.3');

      // Exhaust limit
      for (let i = 0; i < 10; i++) {
        const res = createMockResponse();
        rateLimitMiddlewareWithGlobal(req, res, 'promo_public');
      }

      const res = createMockResponse();
      rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('error', 'Too Many Requests');
      expect(body).toHaveProperty('message');
      expect(body).toHaveProperty('retryAfter');
      expect(body.message).toContain('Rate limit exceeded');
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================
  describe('edge cases', () => {
    it('should handle X-Forwarded-For with multiple IPs (use first)', () => {
      const req = {
        headers: {
          'x-forwarded-for': '203.0.113.1, 198.51.100.1, 192.0.2.1',
        },
        socket: {
          remoteAddress: '127.0.0.1',
        },
      } as unknown as IncomingMessage;

      const res = createMockResponse();
      rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      // Should not throw and should use first IP
      expect(res._statusCode).toBe(200);
    });

    it('should fall back to socket address when no X-Forwarded-For', () => {
      const req = {
        headers: {},
        socket: {
          remoteAddress: '192.168.50.1',
        },
      } as unknown as IncomingMessage;

      const res = createMockResponse();
      const blocked = rateLimitMiddlewareWithGlobal(req, res, 'promo_public');

      expect(blocked).toBe(false);
    });
  });
});

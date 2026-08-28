/**
 * Global test setup for Letter IRL
 *
 * This file runs before each test file and sets up:
 * - Environment variables for test mode
 * - Global mocks for external services (when needed)
 * - Test database configuration
 */

import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Set defaults for missing test env vars
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/letterirl_test';

// The limited-beta gate (#179) is ON when unset, by design: an unconfigured
// production must be guarded, not open. That default would refuse every
// fixture user in this suite, so the test environment matches local
// development and .env.example, both of which set it false.
//
// Set with the same || idiom as the line above, so a test that WANTS the gate
// up can still override it - and several do, either by handing the betaAccess
// helpers an explicit env object or with vi.stubEnv.
process.env.LETTER_IRL_BETA_GATE_ENABLED =
  process.env.LETTER_IRL_BETA_GATE_ENABLED || 'false';

// Mock console.log in tests to reduce noise (optional - comment out to see logs)
// vi.spyOn(console, 'log').mockImplementation(() => {});

// Global test lifecycle hooks
beforeAll(async () => {
  // Any global setup (e.g., start test server, connect to test DB)
});

afterEach(() => {
  // Reset all mocks after each test
  vi.restoreAllMocks();
});

afterAll(async () => {
  // Any global cleanup (e.g., close DB connections)
});

// Extend Vitest's expect with custom matchers if needed
// expect.extend({
//   toBeValidUUID(received) {
//     const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
//     return {
//       pass: uuidRegex.test(received),
//       message: () => `expected ${received} to be a valid UUID`,
//     };
//   },
// });

/**
 * Test fixtures for users
 *
 * Based on personas from docs/PERSONAS.md
 */

export const testUsers = {
  // Sarah - The Occasional Sender
  sarah: {
    user_id: 'auth0|sarah-test-001',
    email: 'sarah@test.letterirl.com',
    credits: 4,
    credits_purchased: 4,
    credits_used: 0,
    tier: 'standard' as const,
  },

  // Marcus - The Regular Correspondent
  marcus: {
    user_id: 'auth0|marcus-test-002',
    email: 'marcus@test.letterirl.com',
    credits: 10,
    credits_purchased: 20,
    credits_used: 10,
    tier: 'trusted' as const,
  },

  // Eleanor - The Legacy Connector
  eleanor: {
    user_id: 'auth0|eleanor-test-003',
    email: 'eleanor@test.letterirl.com',
    credits: 2,
    credits_purchased: 4,
    credits_used: 2,
    tier: 'standard' as const,
  },

  // David - The Business User
  david: {
    user_id: 'auth0|david-test-004',
    email: 'david@test.letterirl.com',
    credits: 50,
    credits_purchased: 100,
    credits_used: 50,
    tier: 'trusted' as const,
  },

  // Alex - The Promo Hunter
  alex: {
    user_id: 'auth0|alex-test-005',
    email: 'alex@test.letterirl.com',
    credits: 2,
    credits_purchased: 0,
    credits_used: 0,
    tier: 'standard' as const,
  },

  // New user with no credits
  newUser: {
    user_id: 'auth0|new-user-test-006',
    email: 'newuser@test.letterirl.com',
    credits: 0,
    credits_purchased: 0,
    credits_used: 0,
    tier: 'standard' as const,
  },

  // User with expiring credits
  expiringCredits: {
    user_id: 'auth0|expiring-test-007',
    email: 'expiring@test.letterirl.com',
    credits: 10,
    credits_purchased: 10,
    credits_used: 0,
    tier: 'standard' as const,
  },

  // Morgan - The MCP Power User
  morgan: {
    user_id: 'auth0|morgan-test-008',
    email: 'morgan@test.letterirl.com',
    credits: 10,
    credits_purchased: 10,
    credits_used: 0,
    tier: 'standard' as const,
  },

  // Jordan - The AI Agent Builder
  jordan: {
    user_id: 'auth0|jordan-test-009',
    email: 'jordan@test.letterirl.com',
    credits: 50,
    credits_purchased: 100,
    credits_used: 50,
    tier: 'trusted' as const,
  },
};

// Helper to create a user with custom properties
export function createTestUser(overrides: Partial<typeof testUsers.sarah> = {}) {
  return {
    ...testUsers.sarah,
    user_id: `auth0|test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ...overrides,
  };
}

// Helper to create user database row format
export function createUserRow(user: typeof testUsers.sarah) {
  return {
    ...user,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

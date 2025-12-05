/**
 * Test fixtures for letters, drafts, and addresses
 */

import { testUsers } from './users.js';

// =============================================================================
// Address Fixtures
// =============================================================================

export const testAddresses = {
  // Valid US addresses
  validSender: {
    name: 'Sarah Test',
    line1: '123 Main Street',
    line2: 'Apt 4B',
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94102',
    country: 'US',
  },

  validRecipient: {
    name: 'John Recipient',
    line1: '456 Oak Avenue',
    line2: null,
    city: 'New York',
    state: 'NY',
    postalCode: '10001',
    country: 'US',
  },

  // Another valid recipient
  validRecipient2: {
    name: 'Jane Smith',
    line1: '789 Pine Road',
    line2: 'Suite 100',
    city: 'Chicago',
    state: 'IL',
    postalCode: '60601',
    country: 'US',
  },

  // Invalid address (non-US)
  invalidNonUS: {
    name: 'Pierre Dupont',
    line1: '10 Rue de la Paix',
    line2: null,
    city: 'Paris',
    state: '',
    postalCode: '75001',
    country: 'FR',
  },

  // Invalid address (missing required fields)
  invalidMissing: {
    name: 'Missing Info',
    line1: '',
    line2: null,
    city: 'Boston',
    state: 'MA',
    postalCode: '02101',
    country: 'US',
  },
};

// =============================================================================
// Letter Content Fixtures
// =============================================================================

export const testLetterContent = {
  // Short letter (under limit)
  shortLetter: {
    bodyText: 'Dear Friend,\n\nI hope this letter finds you well. I wanted to reach out and say hello.\n\nBest wishes',
    signOff: 'Sarah',
  },

  // Medium letter
  mediumLetter: {
    bodyText: `Dear Friend,

I hope this letter finds you in good health and high spirits. It's been quite some time since we last connected, and I wanted to reach out to share some updates from my end.

Life has been busy but fulfilling. I've been working on several projects that I'm excited about, and I've also had the opportunity to explore some new hobbies.

I would love to hear about what's been happening in your world. Perhaps we could arrange a time to catch up properly, either by phone or in person if schedules permit.

Looking forward to hearing from you soon.

Warm regards`,
    signOff: 'Sarah',
  },

  // Long letter (at limit ~1800 chars)
  longLetter: {
    bodyText: `Dear Friend,

I hope this letter finds you well. It has been far too long since we last spoke, and I wanted to take this opportunity to reach out and reconnect.

So much has happened since our last conversation. I've been keeping busy with work, which has been both challenging and rewarding. The team I'm working with is fantastic, and we've accomplished some significant milestones together.

On a personal note, I've taken up gardening as a new hobby. There's something incredibly satisfying about watching plants grow and thrive under your care. My tomato plants are doing particularly well this season.

I've also been doing some traveling. Last month, I visited the coast and spent a wonderful weekend by the ocean. The sunsets were breathtaking, and it was exactly the kind of peaceful retreat I needed.

I've been thinking about you and wondering how things are on your end. I'd love to hear about your adventures, your family, and what's been keeping you busy these days.

If you're ever in the area, please know that you're always welcome to visit. It would be wonderful to catch up in person over a cup of coffee.

Until then, take care of yourself. I'm sending you my warmest thoughts and best wishes for happiness and health.

Looking forward to hearing from you soon.

With much affection`,
    signOff: 'Your friend Sarah',
  },

  // Over-limit letter
  overLimitLetter: {
    bodyText: 'A'.repeat(1900), // Exceeds 1800 char limit
    signOff: 'Test',
  },
};

// =============================================================================
// Draft Fixtures
// =============================================================================

let draftIdCounter = 1;

export function generateDraftId(): string {
  return `draft-${Date.now()}-${draftIdCounter++}`;
}

export interface TestDraft {
  draft_id: string;
  user_id: string;
  sender: string; // JSON stringified
  recipient: string; // JSON stringified
  body_text: string;
  sign_off: string;
  required_credits: number;
  preview_html: string | null;
  sender_validation: string | null;
  recipient_validation: string | null;
  status: 'pending' | 'consumed' | 'expired' | 'cancelled';
  expires_at: Date;
  consumed_at: Date | null;
  consumed_letter_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export function createTestDraft(
  userId: string = testUsers.sarah.user_id,
  options: {
    status?: TestDraft['status'];
    expiresInHours?: number;
    expiredHoursAgo?: number;
    consumedLetterId?: string;
    bodyText?: string;
    signOff?: string;
  } = {}
): TestDraft {
  const {
    status = 'pending',
    expiresInHours = 24,
    expiredHoursAgo,
    consumedLetterId,
    bodyText = testLetterContent.shortLetter.bodyText,
    signOff = testLetterContent.shortLetter.signOff,
  } = options;

  let expiresAt: Date;
  if (expiredHoursAgo !== undefined) {
    expiresAt = new Date(Date.now() - expiredHoursAgo * 60 * 60 * 1000);
  } else {
    expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
  }

  const draft: TestDraft = {
    draft_id: generateDraftId(),
    user_id: userId,
    sender: JSON.stringify(testAddresses.validSender),
    recipient: JSON.stringify(testAddresses.validRecipient),
    body_text: bodyText,
    sign_off: signOff,
    required_credits: 2,
    preview_html: '<html><body>Preview</body></html>',
    sender_validation: JSON.stringify({ status: 'verified' }),
    recipient_validation: JSON.stringify({ status: 'verified' }),
    status,
    expires_at: expiresAt,
    consumed_at: status === 'consumed' ? new Date() : null,
    consumed_letter_id: consumedLetterId ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  return draft;
}

// Pre-built draft scenarios
export const testDrafts = {
  // Valid pending draft
  pending: () => createTestDraft(testUsers.sarah.user_id, { status: 'pending' }),

  // Already consumed draft (for idempotency tests)
  consumed: () =>
    createTestDraft(testUsers.sarah.user_id, {
      status: 'consumed',
      consumedLetterId: 'letter-existing-001',
    }),

  // Expired draft
  expired: () =>
    createTestDraft(testUsers.sarah.user_id, {
      status: 'expired',
      expiredHoursAgo: 2,
    }),

  // Cancelled draft
  cancelled: () =>
    createTestDraft(testUsers.sarah.user_id, {
      status: 'cancelled',
    }),

  // Draft about to expire (< 1 hour)
  expiringSoon: () =>
    createTestDraft(testUsers.sarah.user_id, {
      status: 'pending',
      expiresInHours: 0.5,
    }),

  // Draft belonging to different user
  differentUser: () =>
    createTestDraft(testUsers.marcus.user_id, { status: 'pending' }),
};

// =============================================================================
// Letter Fixtures
// =============================================================================

let letterIdCounter = 1;

export function generateLetterId(): string {
  return `letter-${Date.now()}-${letterIdCounter++}`;
}

export interface TestLetter {
  letter_id: string;
  user_id: string;
  sender: string;
  recipient: string;
  body_text: string;
  sign_off: string;
  status: 'queued' | 'processing' | 'in_transit' | 'delivered' | 'returned' | 'sent' | 'failed' | 'cancelled';
  tracking_id: string | null;
  expected_delivery: Date | null;
  provider: string;
  provider_letter_id: string | null;
  status_updated_at: Date | null;
  provider_raw_status: string | null;
  created_at: Date;
  updated_at: Date;
}

export function createTestLetter(
  userId: string = testUsers.sarah.user_id,
  options: {
    status?: TestLetter['status'];
    trackingId?: string;
    createdDaysAgo?: number;
    providerRawStatus?: string;
  } = {}
): TestLetter {
  const { status = 'queued', trackingId, createdDaysAgo = 0, providerRawStatus } = options;

  const createdAt = new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000);

  return {
    letter_id: generateLetterId(),
    user_id: userId,
    sender: JSON.stringify(testAddresses.validSender),
    recipient: JSON.stringify(testAddresses.validRecipient),
    body_text: testLetterContent.shortLetter.bodyText,
    sign_off: testLetterContent.shortLetter.signOff,
    status,
    tracking_id: trackingId ?? null,
    expected_delivery: status === 'sent' || status === 'in_transit' || status === 'delivered'
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null,
    provider: 'postgrid',
    provider_letter_id: trackingId ? `pg_letter_${Date.now()}` : null,
    status_updated_at: providerRawStatus ? new Date() : null,
    provider_raw_status: providerRawStatus ?? null,
    created_at: createdAt,
    updated_at: new Date(),
  };
}

// =============================================================================
// Status Sync Test Fixtures
// =============================================================================

/**
 * Create a letter row as returned from database for status sync
 */
export function createLetterRowForSync(
  options: {
    letterId?: string;
    userId?: string;
    trackingId?: string;
    status?: TestLetter['status'];
    createdDaysAgo?: number;
  } = {}
): {
  letter_id: string;
  tracking_id: string;
  status: string;
  provider: string;
  created_at: Date;
} {
  const {
    letterId = generateLetterId(),
    userId = testUsers.sarah.user_id,
    trackingId = `pg_track_${Date.now()}`,
    status = 'processing',
    createdDaysAgo = 5,
  } = options;

  return {
    letter_id: letterId,
    tracking_id: trackingId,
    status,
    provider: 'postgrid',
    created_at: new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000),
  };
}

/**
 * Create multiple letters for status sync testing
 */
export function createStatusSyncTestLetters(): Array<{
  letter_id: string;
  tracking_id: string;
  status: string;
  provider: string;
  created_at: Date;
}> {
  return [
    // Letter in processing status (should be checked)
    createLetterRowForSync({
      letterId: 'letter-sync-1',
      trackingId: 'track-1',
      status: 'processing',
      createdDaysAgo: 5,
    }),
    // Letter in in_transit status (should be checked)
    createLetterRowForSync({
      letterId: 'letter-sync-2',
      trackingId: 'track-2',
      status: 'in_transit',
      createdDaysAgo: 10,
    }),
    // Letter in queued status (should be checked)
    createLetterRowForSync({
      letterId: 'letter-sync-3',
      trackingId: 'track-3',
      status: 'queued',
      createdDaysAgo: 2,
    }),
  ];
}

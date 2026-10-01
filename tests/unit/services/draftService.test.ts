/**
 * Unit tests for draftService
 *
 * Tests the draft-based idempotency system:
 * - Creating drafts for letter previews
 * - Consuming drafts atomically
 * - Handling duplicate send requests (idempotency)
 * - Expiration and error handling
 *
 * User Stories Covered:
 * - US-1.1: Preview a Letter (draft creation)
 * - US-1.3: Idempotent Send (duplicate detection)
 * - US-6.1: Draft Expiration
 * - US-6.7: Expired Draft Recovery
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testUsers } from '../../fixtures/users.js';
import {
  testDrafts,
  testAddresses,
  testLetterContent,
  createTestDraft,
} from '../../fixtures/letters.js';

// Mock the database module before importing the service
vi.mock('../../../src/db/index.js', () => {
  return {
    query: vi.fn(),
    transaction: vi.fn(),
  };
});

// Import after mocking
import * as db from '../../../src/db/index.js';
import {
  createDraft,
  createPostcardDraft,
  consumeDraft,
  linkDraftToLetter,
  getDraft,
  markExpiredDrafts,
  cancelDraft,
} from '../../../src/services/draftService.js';

describe('draftService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // createDraft Tests
  // ==========================================================================
  describe('createDraft', () => {
    it('should create a draft with 24-hour expiration by default', async () => {
      const mockDraft = testDrafts.pending();

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ draft_id: mockDraft.draft_id, expires_at: mockDraft.expires_at }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      const result = await createDraft({
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender,
        recipient: testAddresses.validRecipient,
        bodyText: testLetterContent.shortLetter.bodyText,
        signOff: testLetterContent.shortLetter.signOff,
        requiredCredits: 2,
      });

      expect(result.draftId).toBe(mockDraft.draft_id);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO letter_drafts'),
        expect.any(Array)
      );
    });

    it('does not log draft, user, recipient, or address identifiers', async () => {
      const mockDraft = testDrafts.pending();
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ draft_id: mockDraft.draft_id, expires_at: mockDraft.expires_at }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: []
      });
      const diagnostic = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await createDraft({
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender,
        recipient: testAddresses.validRecipient,
        bodyText: testLetterContent.shortLetter.bodyText,
        signOff: testLetterContent.shortLetter.signOff,
        requiredCredits: 2
      });

      const output = diagnostic.mock.calls.flat().map(String).join('\n');
      expect(output).toContain('"event":"draft.created"');
      for (const value of [
        mockDraft.draft_id,
        testUsers.sarah.user_id,
        testAddresses.validRecipient.name,
        testAddresses.validRecipient.addressLine1
      ]) {
        expect(output).not.toContain(value);
      }
    });

    it('should create a draft with custom expiration', async () => {
      const mockDraft = createTestDraft(testUsers.sarah.user_id, {
        expiresInHours: 12,
      });

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ draft_id: mockDraft.draft_id, expires_at: mockDraft.expires_at }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      const result = await createDraft({
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender,
        recipient: testAddresses.validRecipient,
        bodyText: testLetterContent.shortLetter.bodyText,
        signOff: testLetterContent.shortLetter.signOff,
        requiredCredits: 2,
        expiresInHours: 12,
      });

      expect(result.draftId).toBe(mockDraft.draft_id);
    });

    it('should include preview HTML and validation results', async () => {
      const mockDraft = testDrafts.pending();

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ draft_id: mockDraft.draft_id, expires_at: mockDraft.expires_at }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      await createDraft({
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender,
        recipient: testAddresses.validRecipient,
        bodyText: testLetterContent.shortLetter.bodyText,
        signOff: testLetterContent.shortLetter.signOff,
        requiredCredits: 2,
        previewHtml: '<html>Preview</html>',
        senderValidation: { status: 'verified' },
        recipientValidation: { status: 'corrected', corrections: ['ZIP+4 added'] },
      });

      // Verify the query was called with all parameters
      const queryCall = vi.mocked(db.query).mock.calls[0];
      expect(queryCall[1]).toContain('<html>Preview</html>');
    });

    it('records the renderer that drew the preview (#534), and none for the legacy HTML', async () => {
      const mockDraft = testDrafts.pending();
      const inserted = {
        rows: [{ draft_id: mockDraft.draft_id, expires_at: mockDraft.expires_at }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };
      vi.mocked(db.query).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted);
      const draft = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender,
        recipient: testAddresses.validRecipient,
        bodyText: testLetterContent.shortLetter.bodyText,
        signOff: testLetterContent.shortLetter.signOff,
        requiredCredits: 2,
      };

      await createDraft({ ...draft, rendererVersion: 'pdf-1' });
      await createDraft(draft);

      const [sql, rendered] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
      const list = (from: number) => sql.slice(sql.indexOf('(', from) + 1, sql.indexOf(')', from)).split(',').map(item => item.trim());
      const columns = list(0);
      const values = list(sql.indexOf('VALUES'));
      expect(values).toHaveLength(columns.length);
      const position = columns.indexOf('renderer_version');
      expect(position).toBeGreaterThan(-1);
      // The column's value is a placeholder, and that parameter is the version.
      const placeholder = /^\$(\d+)$/.exec(values[position]);
      expect(placeholder).not.toBeNull();
      const parameter = Number(placeholder![1]) - 1;
      expect(rendered[parameter]).toBe('pdf-1');
      expect((vi.mocked(db.query).mock.calls[1][1] as unknown[])[parameter]).toBeNull();
    });
  });

  describe('arrive-by dates (#535)', () => {
    const inserted = {
      rows: [{ draft_id: 'draft-1', expires_at: new Date('2026-10-02T12:00:00Z') }],
      rowCount: 1,
      command: 'INSERT',
      oid: 0,
      fields: [],
    };
    /** The value each named column was inserted with. */
    function columnValues(call: unknown[]): Record<string, unknown> {
      const [sql, params] = call as [string, unknown[]];
      const list = (from: number) => sql.slice(sql.indexOf('(', from) + 1, sql.indexOf(')', from)).split(',').map(item => item.trim());
      const columns = list(0);
      const values = list(sql.indexOf('VALUES'));
      expect(values).toHaveLength(columns.length);
      return Object.fromEntries(columns.map((column, index) => {
        const placeholder = /^\$(\d+)(::\w+)?$/.exec(values[index]);
        return [column, placeholder ? { value: params[Number(placeholder[1]) - 1], cast: placeholder[2] ?? null } : values[index]];
      }));
    }

    it('records a letter draft\'s dates as DATE parameters, and none to mail as soon as possible', async () => {
      vi.mocked(db.query).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted);
      const base = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender as unknown as Record<string, unknown>,
        recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
        bodyText: 'Hello',
        signOff: 'Love',
        requiredCredits: 2,
      };

      await createDraft({ ...base, schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' } });
      await createDraft(base);

      const scheduled = columnValues(vi.mocked(db.query).mock.calls[0]);
      expect(scheduled.arrive_by).toEqual({ value: '2026-10-16', cast: '::date' });
      expect(scheduled.mail_on).toEqual({ value: '2026-10-06', cast: '::date' });
      const asap = columnValues(vi.mocked(db.query).mock.calls[1]);
      expect(asap.arrive_by).toEqual({ value: null, cast: '::date' });
      expect(asap.mail_on).toEqual({ value: null, cast: '::date' });
    });

    it('records a postcard draft\'s dates the same way', async () => {
      vi.mocked(db.query).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted);
      const base = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender as unknown as Record<string, unknown>,
        recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
        message: 'Wish you were here.',
        frontImageData: 'data:image/jpeg;base64,AAAA',
        frontImageUrl: 'https://files.example/a.jpg',
      };

      await createPostcardDraft({ ...base, schedule: { arriveBy: '2026-10-16', mailOn: '2026-10-06' } });
      await createPostcardDraft(base);

      const scheduled = columnValues(vi.mocked(db.query).mock.calls[0]);
      expect([scheduled.arrive_by, scheduled.mail_on]).toEqual([
        { value: '2026-10-16', cast: '::date' },
        { value: '2026-10-06', cast: '::date' }
      ]);
      const asap = columnValues(vi.mocked(db.query).mock.calls[1]);
      expect([asap.arrive_by, asap.mail_on]).toEqual([{ value: null, cast: '::date' }, { value: null, cast: '::date' }]);
    });
  });

  describe('createPostcardDraft', () => {
    it('records the renderer that drew the preview (#534 Phase 4), and none for the legacy HTML', async () => {
      const inserted = {
        rows: [{ draft_id: 'draft-1', expires_at: new Date('2026-10-02T12:00:00Z') }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };
      vi.mocked(db.query).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted);
      const draft = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender as unknown as Record<string, unknown>,
        recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
        message: 'Wish you were here.',
        frontImageData: 'data:image/jpeg;base64,AAAA',
        frontImageUrl: 'https://files.example/a.jpg',
      };

      await createPostcardDraft({ ...draft, rendererVersion: 'pdf-1' });
      await createPostcardDraft(draft);

      const [sql, rendered] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
      const list = (from: number) => sql.slice(sql.indexOf('(', from) + 1, sql.indexOf(')', from)).split(',').map(item => item.trim());
      const columns = list(0);
      const values = list(sql.indexOf('VALUES'));
      expect(values).toHaveLength(columns.length);
      const position = columns.indexOf('renderer_version');
      expect(position).toBeGreaterThan(-1);
      const placeholder = /^\$(\d+)$/.exec(values[position]);
      expect(placeholder).not.toBeNull();
      const parameter = Number(placeholder![1]) - 1;
      expect(rendered[parameter]).toBe('pdf-1');
      expect((vi.mocked(db.query).mock.calls[1][1] as unknown[])[parameter]).toBeNull();
      // Every placeholder has its parameter (a placeholder may carry a cast, as $15::date does).
      expect(rendered).toHaveLength(Math.max(...values.map(value => Number(/^\$(\d+)(?:::\w+)?$/.exec(value)?.[1] ?? 0))));
    });
  });

  // ==========================================================================
  // consumeDraft Tests - Idempotency (US-1.3)
  // ==========================================================================
  describe('consumeDraft', () => {
    it('should consume a pending draft successfully', async () => {
      const mockDraft = testDrafts.pending();
      const consumedDraft = { ...mockDraft, status: 'consumed' as const, consumed_at: new Date() };

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // SELECT FOR UPDATE (lock draft)
            .mockResolvedValueOnce({ rows: [mockDraft] })
            // UPDATE to consumed
            .mockResolvedValueOnce({ rows: [consumedDraft] }),
        };
        return callback(mockClient as any);
      });

      const result = await consumeDraft({
        draftId: mockDraft.draft_id,
        userId: testUsers.sarah.user_id,
      });

      expect(result.alreadyConsumed).toBe(false);
      expect(result.draft.status).toBe('consumed');
    });

    it('should return existing letter for already-consumed draft (idempotency)', async () => {
      const mockDraft = testDrafts.consumed();

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn()
            // SELECT FOR UPDATE returns already-consumed draft
            .mockResolvedValueOnce({ rows: [mockDraft] }),
        };
        return callback(mockClient as any);
      });

      const result = await consumeDraft({
        draftId: mockDraft.draft_id,
        userId: testUsers.sarah.user_id,
      });

      expect(result.alreadyConsumed).toBe(true);
      expect(result.existingLetterId).toBe('letter-existing-001');
    });

    it('should throw DRAFT_NOT_FOUND for non-existent draft', async () => {
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn().mockResolvedValueOnce({ rows: [] }),
        };
        return callback(mockClient as any);
      });

      await expect(
        consumeDraft({
          draftId: 'nonexistent-draft',
          userId: testUsers.sarah.user_id,
        })
      ).rejects.toMatchObject({
        code: 'DRAFT_NOT_FOUND',
      });
    });

    it('should throw DRAFT_NOT_OWNED for draft belonging to different user', async () => {
      const mockDraft = testDrafts.differentUser(); // Belongs to Marcus

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn().mockResolvedValueOnce({ rows: [mockDraft] }),
        };
        return callback(mockClient as any);
      });

      await expect(
        consumeDraft({
          draftId: mockDraft.draft_id,
          userId: testUsers.sarah.user_id, // Sarah trying to use Marcus's draft
        })
      ).rejects.toMatchObject({
        code: 'DRAFT_NOT_OWNED',
      });
    });

    it('should throw DRAFT_EXPIRED for expired draft', async () => {
      const mockDraft = testDrafts.expired();

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn().mockResolvedValueOnce({ rows: [mockDraft] }),
        };
        return callback(mockClient as any);
      });

      await expect(
        consumeDraft({
          draftId: mockDraft.draft_id,
          userId: testUsers.sarah.user_id,
        })
      ).rejects.toMatchObject({
        code: 'DRAFT_EXPIRED',
      });
    });

    it('should throw DRAFT_CANCELLED for cancelled draft', async () => {
      const mockDraft = testDrafts.cancelled();

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn().mockResolvedValueOnce({ rows: [mockDraft] }),
        };
        return callback(mockClient as any);
      });

      await expect(
        consumeDraft({
          draftId: mockDraft.draft_id,
          userId: testUsers.sarah.user_id,
        })
      ).rejects.toMatchObject({
        code: 'DRAFT_CANCELLED',
      });
    });

    it('should throw DRAFT_EXPIRED for pending draft past expiration time', async () => {
      // Draft with pending status but expires_at in the past
      const mockDraft = createTestDraft(testUsers.sarah.user_id, {
        status: 'pending',
        expiredHoursAgo: 1, // Expired 1 hour ago
      });

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const mockClient = {
          query: vi.fn().mockResolvedValueOnce({ rows: [mockDraft] }),
        };
        return callback(mockClient as any);
      });

      await expect(
        consumeDraft({
          draftId: mockDraft.draft_id,
          userId: testUsers.sarah.user_id,
        })
      ).rejects.toMatchObject({
        code: 'DRAFT_EXPIRED',
      });
    });
  });

  // ==========================================================================
  // linkDraftToLetter Tests
  // ==========================================================================
  describe('linkDraftToLetter', () => {
    it('should link consumed draft to created letter', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      await linkDraftToLetter('draft-123', 'letter-456');

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE letter_drafts'),
        ['draft-123', 'letter-456']
      );
    });
  });

  // ==========================================================================
  // getDraft Tests
  // ==========================================================================
  describe('getDraft', () => {
    it('should return draft by ID', async () => {
      const mockDraft = testDrafts.pending();

      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [mockDraft],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await getDraft(mockDraft.draft_id);

      expect(result).toEqual(mockDraft);
    });

    it('should return null for non-existent draft', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await getDraft('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // markExpiredDrafts Tests
  // ==========================================================================
  describe('markExpiredDrafts', () => {
    it('should mark expired drafts and return count', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ draft_id: 'd1' }, { draft_id: 'd2' }],
        rowCount: 2,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      const count = await markExpiredDrafts();

      expect(count).toBe(2);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'expired'")
      );
    });

    it('should return 0 when no drafts expired', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      const count = await markExpiredDrafts();

      expect(count).toBe(0);
    });
  });

  // ==========================================================================
  // cancelDraft Tests
  // ==========================================================================
  describe('cancelDraft', () => {
    it('should cancel a pending draft', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ draft_id: 'draft-123' }],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      const result = await cancelDraft('draft-123', testUsers.sarah.user_id);

      expect(result).toBe(true);
    });

    it('should return false when draft not found or wrong user', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      const result = await cancelDraft('draft-123', testUsers.sarah.user_id);

      expect(result).toBe(false);
    });
  });
});

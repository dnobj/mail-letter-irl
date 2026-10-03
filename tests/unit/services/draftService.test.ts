import { createHash } from 'node:crypto';
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
  cleanupOldDrafts,
  cancelDraft,
  setDraftSchedule,
  setDraftSignature,
  setDraftStationery,
  setDraftWords,
  getDraftForStationery,
  getDraftForPostcardStyle,
  setDraftPostcardStyle,
  getDraftState,
  LIVE_PAY_AND_SEND_STATUSES,
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

    it('stores the signature a preview was drawn with in its own column, and NULL without one (#608)', async () => {
      const signature = 'data:image/png;base64,iVBORw0KGgo=';
      const inserted = { rows: [{ draft_id: 'draft-s', expires_at: new Date() }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      vi.mocked(db.query).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted);
      const params = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender,
        recipient: testAddresses.validRecipient,
        bodyText: testLetterContent.shortLetter.bodyText,
        signOff: testLetterContent.shortLetter.signOff,
        requiredCredits: 2
      };

      await createDraft({ ...params, rendererVersion: 'pdf-4', signatureImage: signature });
      await createDraft({ ...params, rendererVersion: 'pdf-1' });

      const [signed, plain] = vi.mocked(db.query).mock.calls as unknown as Array<[string, unknown[]]>;
      expect(signed[0]).toMatch(/stationery, pages, signature_image\s*\) VALUES \([\s\S]*\$21::smallint, \$22\)/);
      expect(signed[1][21]).toBe(signature);
      expect(signed[1][15]).toBe('pdf-4');
      expect(plain[1][21]).toBeNull();
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

    it("records a letter draft's stationery as JSON, and none for Classic (#563)", async () => {
      vi.mocked(db.query).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted);
      const base = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender as unknown as Record<string, unknown>,
        recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
        bodyText: 'Hello',
        signOff: 'Love',
        requiredCredits: 2,
      };
      const botanical = { theme: 'botanical' as const, dateLine: 'October 1, 2026' };

      await createDraft({ ...base, rendererVersion: 'pdf-2', stationery: botanical });
      await createDraft({ ...base, rendererVersion: 'pdf-1', stationery: { theme: 'classic' } });
      await createDraft({ ...base, rendererVersion: 'pdf-1' });

      const themed = columnValues(vi.mocked(db.query).mock.calls[0]);
      expect(themed.stationery).toEqual({ value: JSON.stringify(botanical), cast: '::jsonb' });
      expect(themed.renderer_version).toEqual({ value: 'pdf-2', cast: null });
      expect(columnValues(vi.mocked(db.query).mock.calls[1]).stationery).toEqual({ value: null, cast: '::jsonb' });
      expect(columnValues(vi.mocked(db.query).mock.calls[2]).stationery).toEqual({ value: null, cast: '::jsonb' });
    });

    it('stores a theme only as the print reads it back, and refuses one it would not read (#563 review round 3)', async () => {
      vi.mocked(db.query).mockResolvedValueOnce(inserted);
      const base = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender as unknown as Record<string, unknown>,
        recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
        bodyText: 'Hello',
        signOff: 'Love',
        requiredCredits: 2,
        rendererVersion: 'pdf-2'
      };
      // A key the print does not read is not stored.
      const extra = { theme: 'celebration', dateLine: 'October 1, 2026', headline: 'Happy Birthday!', colour: 'red' };
      await createDraft({ ...base, stationery: extra as unknown as Parameters<typeof createDraft>[0]['stationery'] });
      expect(columnValues(vi.mocked(db.query).mock.calls[0]).stationery).toEqual({
        value: JSON.stringify({ theme: 'celebration', dateLine: 'October 1, 2026', headline: 'Happy Birthday!' }),
        cast: '::jsonb'
      });

      // A slot past the stored bound, which the print would refuse, and a theme it does not know.
      for (const stationery of [
        { theme: 'celebration', headline: 'Happy ' + ' '.repeat(250) + 'Birthday' },
        { theme: 'floral' }
      ]) {
        await expect(
          createDraft({ ...base, stationery: stationery as unknown as Parameters<typeof createDraft>[0]['stationery'] })
        ).rejects.toMatchObject({
          message: 'The stationery cannot be stored: the print would not read it back.',
          code: 'STATIONERY_UNREADABLE',
          diagnosticClass: 'validation_error'
        });
      }
      expect(db.query).toHaveBeenCalledTimes(1);

      // None is Classic, as unset is (#569 review round 4).
      vi.mocked(db.query).mockResolvedValueOnce(inserted);
      await createDraft({ ...base, rendererVersion: 'pdf-1', stationery: null });
      expect(columnValues(vi.mocked(db.query).mock.calls[1]).stationery).toEqual({ value: null, cast: '::jsonb' });
    });

    describe('the pages a letter prints on (#586)', () => {
      const base = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender as unknown as Record<string, unknown>,
        recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
        bodyText: 'Hello',
        signOff: 'Love',
        requiredCredits: 2,
      };

      it('records the pages a preview laid the letter out on as a SMALLINT, one by default', async () => {
        vi.mocked(db.query).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted);
        await createDraft({ ...base, rendererVersion: 'pdf-1', pages: 3 });
        await createDraft({ ...base, rendererVersion: 'pdf-2', stationery: { theme: 'botanical', dateLine: 'October 2, 2026' }, pages: 2 });
        await createDraft(base);
        expect(columnValues(vi.mocked(db.query).mock.calls[0]).pages).toEqual({ value: 3, cast: '::smallint' });
        expect(columnValues(vi.mocked(db.query).mock.calls[1]).pages).toEqual({ value: 2, cast: '::smallint' });
        expect(columnValues(vi.mocked(db.query).mock.calls[2]).pages).toEqual({ value: 1, cast: '::smallint' });
      });

      it.each([
        ['no page', { pages: 0, rendererVersion: 'pdf-1' }],
        ['four pages', { pages: 4, rendererVersion: 'pdf-1' }],
        ['part of a page', { pages: 1.5, rendererVersion: 'pdf-1' }],
        ['two pages of the legacy HTML', { pages: 2 }],
        ['two pages of a gift send', { pages: 2, rendererVersion: 'pdf-1', isGiftSend: true }]
      ])('refuses %s before writing anything', async (_label, extra) => {
        await expect(createDraft({ ...base, ...extra })).rejects.toMatchObject({
          message: 'The letter cannot be stored on that many pages.',
          code: 'DRAFT_PAGES_INVALID',
          diagnosticClass: 'validation_error'
        });
        expect(db.query).not.toHaveBeenCalled();
      });

      it('takes three pages, the most the renderer lays out, and one page of a gift send', async () => {
        vi.mocked(db.query).mockResolvedValueOnce(inserted).mockResolvedValueOnce(inserted);
        await expect(createDraft({ ...base, rendererVersion: 'pdf-1', pages: 3 })).resolves.toMatchObject({ draftId: 'draft-1' });
        await expect(createDraft({ ...base, rendererVersion: 'pdf-1', pages: 1, isGiftSend: true })).resolves.toMatchObject({ draftId: 'draft-1' });
        expect(columnValues(vi.mocked(db.query).mock.calls[1]).pages).toEqual({ value: 1, cast: '::smallint' });
      });
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

    it('stores a front as the print reads it back, beside its renderer, and none for full bleed (#594)', async () => {
      const inserted = {
        rows: [{ draft_id: 'draft-1', expires_at: new Date('2026-10-02T12:00:00Z') }],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      };
      vi.mocked(db.query).mockResolvedValue(inserted);
      const draft = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender as unknown as Record<string, unknown>,
        recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
        message: 'Wish you were here.',
        frontImageData: 'data:image/jpeg;base64,AAAA',
        frontImageUrl: 'https://files.example/a.jpg',
      };

      await createPostcardDraft({ ...draft, rendererVersion: 'pdf-3', postcardFront: { layout: 'greetings', place: 'Asheville' } });
      await createPostcardDraft({ ...draft, rendererVersion: 'pdf-1', postcardFront: null });
      await createPostcardDraft({ ...draft, rendererVersion: 'pdf-1' });

      const [sql, withFront] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
      const list = (from: number) => sql.slice(sql.indexOf('(', from) + 1, sql.indexOf(')', from)).split(',').map(item => item.trim());
      const columns = list(0);
      const values = list(sql.indexOf('VALUES'));
      expect(values).toHaveLength(columns.length);
      const position = columns.indexOf('postcard_front');
      expect(values[position]).toMatch(/^\$\d+::jsonb$/);
      const parameter = Number(/^\$(\d+)/.exec(values[position])![1]) - 1;
      expect(JSON.parse(withFront[parameter] as string)).toEqual({ layout: 'greetings', place: 'Asheville' });
      expect((vi.mocked(db.query).mock.calls[1][1] as unknown[])[parameter]).toBeNull();
      expect((vi.mocked(db.query).mock.calls[2][1] as unknown[])[parameter]).toBeNull();
    });

    it('refuses a front the print would not read back, before writing anything (#594)', async () => {
      vi.mocked(db.query).mockClear();
      const draft = {
        userId: testUsers.sarah.user_id,
        sender: testAddresses.validSender as unknown as Record<string, unknown>,
        recipient: testAddresses.validRecipient as unknown as Record<string, unknown>,
        message: 'Wish you were here.',
        frontImageData: 'data:image/jpeg;base64,AAAA',
        frontImageUrl: 'https://files.example/a.jpg',
        rendererVersion: 'pdf-3'
      };
      for (const front of [{ layout: 'greetings' }, { layout: 'border', place: 'Rye' }, { layout: 'collage' }]) {
        await expect(createPostcardDraft({ ...draft, postcardFront: front as never }), JSON.stringify(front))
          .rejects.toMatchObject({ code: 'POSTCARD_FRONT_UNREADABLE', diagnosticClass: 'validation_error' });
      }
      expect(db.query).not.toHaveBeenCalled();
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
  // cleanupOldDrafts Tests
  // ==========================================================================
  describe('cleanupOldDrafts', () => {
    it("keeps a held letter's sent draft until its own days after the mail date (#564)", async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ draft_id: 'd1' }], rowCount: 1, command: 'DELETE', oid: 0, fields: [] });
      const before = Date.now();

      await expect(cleanupOldDrafts(7)).resolves.toBe(1);

      const [sql, params] = vi.mocked(db.query).mock.calls[0] as unknown as [string, [Date, number]];
      expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM orders WHERE orders\.draft_id = letter_drafts\.draft_id\s*\)/);
      expect(sql).toMatch(
        /NOT EXISTS \(\s*SELECT 1 FROM letters\s+WHERE letters\.letter_id = letter_drafts\.consumed_letter_id\s+AND letters\.mail_on >= CURRENT_DATE - \$2::int\s*\)/
      );
      // The timestamp cutoff and the day count are separate parameters: one
      // parameter cast two ways silently takes the first type.
      expect(sql.match(/\$1/g)).toHaveLength(1);
      expect(sql.match(/\$2/g)).toHaveLength(1);
      expect(params[0]).toBeInstanceOf(Date);
      expect(Math.abs(before - 7 * 24 * 60 * 60 * 1000 - params[0].getTime())).toBeLessThan(5_000);
      expect(params[1]).toBe(7);
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

  // ==========================================================================
  // setDraftSchedule Tests (#535, set_arrival_date)
  // ==========================================================================
  describe('setDraftSchedule', () => {
    const NOW = new Date('2026-10-01T14:00:00Z');
    const DATES = { arriveBy: '2026-10-16', mailOn: '2026-10-06' };
    const pending = { status: 'pending', expires_at: new Date('2026-10-02T09:00:00Z') };

    /** A transaction whose statements answer in turn; the client is returned to read its calls. */
    function inTransaction(...answers: Array<{ rows: unknown[] }>) {
      const client = { query: vi.fn() };
      for (const answer of answers) client.query.mockResolvedValueOnce(answer);
      client.query.mockResolvedValue({ rows: [], rowCount: 1 });
      vi.mocked(db.transaction).mockImplementation(async callback => callback(client as any));
      return client;
    }

    it("locks the caller's draft, finds no live Pay & Send order, and writes the dates as DATE parameters", async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] });

      await expect(setDraftSchedule('draft-1', 'auth0|owner', DATES, NOW)).resolves.toBeNull();

      const [lock, live, update] = client.query.mock.calls as Array<[string, unknown[]]>;
      expect(lock[0]).toMatch(/SELECT status, expires_at, redacted_at FROM letter_drafts WHERE draft_id = \$1 AND user_id = \$2 FOR UPDATE/);
      expect(lock[1]).toEqual(['draft-1', 'auth0|owner']);
      expect(live[0]).toMatch(/FROM orders/);
      expect(live[0]).toMatch(/order_type = 'jit_mail'/);
      expect(live[0]).toMatch(/status = ANY\(\$2::varchar\[\]\)/);
      // A checkout whose window has passed can no longer be paid.
      expect(live[0]).toMatch(/status <> 'checkout_pending' OR checkout_expires_at IS NULL OR checkout_expires_at > NOW\(\)/);
      expect(live[1]).toEqual(['draft-1', [...LIVE_PAY_AND_SEND_STATUSES]]);
      expect(update[0]).toMatch(/UPDATE letter_drafts\s+SET arrive_by = \$2::date, mail_on = \$3::date, updated_at = NOW\(\)\s+WHERE draft_id = \$1/);
      expect(update[1]).toEqual(['draft-1', '2026-10-16', '2026-10-06']);
      expect(client.query).toHaveBeenCalledTimes(3);
    });

    it('clears the dates with NULLs', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] });

      await expect(setDraftSchedule('draft-1', 'auth0|owner', null, NOW)).resolves.toBeNull();

      expect(client.query.mock.calls[2][1]).toEqual(['draft-1', null, null]);
    });

    it.each([
      ['a missing draft, or one that is not the caller\'s', [], 'not_found'],
      ['a sent draft', [{ ...pending, status: 'consumed' }], 'sent'],
      ['an expired draft', [{ ...pending, status: 'expired' }], 'expired'],
      ['a cancelled draft', [{ ...pending, status: 'cancelled' }], 'expired'],
      ['a pending draft past its expiry', [{ ...pending, expires_at: new Date('2026-10-01T14:00:00Z') }], 'expired'],
      // Emptied by an erasure, still pending (#573 review round 1).
      ['a draft an erasure emptied', [{ ...pending, redacted_at: new Date('2026-10-01T13:59:00Z') }], 'expired'],
      // A sent letter's draft the paid-draft sweep emptied is still sent (#573 review round 2).
      ['a sent draft the sweep emptied', [{ ...pending, status: 'consumed', redacted_at: new Date('2026-10-01T13:59:00Z') }], 'sent']
    ])('leaves %s alone, reading nothing more', async (_label, rows, refusal) => {
      const client = inTransaction({ rows });

      await expect(setDraftSchedule('draft-1', 'auth0|owner', DATES, NOW)).resolves.toBe(refusal);

      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it('leaves a draft with a live Pay & Send order alone', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [{ '?column?': 1 }] });

      await expect(setDraftSchedule('draft-1', 'auth0|owner', DATES, NOW)).resolves.toBe('checkout_pending');

      expect(client.query).toHaveBeenCalledTimes(2);
    });

    it('reads the expiry against the clock it is given', async () => {
      inTransaction({ rows: [pending] }, { rows: [] });
      await expect(setDraftSchedule('draft-1', 'auth0|owner', DATES, new Date('2026-10-02T08:59:59Z'))).resolves.toBeNull();
      inTransaction({ rows: [pending] });
      await expect(setDraftSchedule('draft-1', 'auth0|owner', DATES, new Date('2026-10-02T09:00:00Z'))).resolves.toBe('expired');
    });
  });
});

describe('draftService stationery (#563)', () => {
  const NOW = new Date('2026-10-01T14:00:00Z');
  const pending = { status: 'pending', expires_at: new Date('2026-10-02T09:00:00Z') };
  const BOTANICAL = { theme: 'botanical' as const, dateLine: 'October 1, 2026' };
  const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-2"><svg></svg></body></html>';
  // The words a restyle drew its page from, and the row as the lock reads them again (#586).
  const WORDS = { bodyText: 'Dear Sam,', signOff: 'Pat' };
  const DRAWN = { body_text: 'Dear Sam,', sign_off: 'Pat', stationery: null };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A transaction whose statements answer in turn; the client is returned to read its calls. */
  function inTransaction(...answers: Array<{ rows: unknown[] }>) {
    const client = { query: vi.fn() };
    for (const answer of answers) client.query.mockResolvedValueOnce(answer);
    client.query.mockResolvedValue({ rows: [], rowCount: 1 });
    vi.mocked(db.transaction).mockImplementation(async callback => callback(client as any));
    return client;
  }

  describe('getDraftState', () => {
    it('reads what get_draft_status prices a ready letter by (#586)', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ draft_id: 'draft-1' }] } as any);
      await expect(getDraftState('draft-1')).resolves.toEqual({ draft_id: 'draft-1' });
      const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
      for (const column of ['d.pages', 'd.is_gift_send', 'd.required_credits']) {
        expect(sql, column).toContain(column);
      }
      expect(params).toEqual(['draft-1']);
    });
  });

  describe('getDraftForStationery', () => {
    it("reads the caller's draft with what its page is drawn from", async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ mail_type: 'letter' }] } as any);
      await expect(getDraftForStationery('draft-1', 'auth0|owner')).resolves.toEqual({ mail_type: 'letter' });
      const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
      for (const column of ['mail_type', 'status', 'expires_at', 'redacted_at', 'renderer_version', 'body_text', 'sign_off', 'layout_type',
        'header_image_data', 'inline_image_data', 'sender', 'recipient', 'preview_html', 'pages', 'is_gift_send', 'required_credits',
        // And the draft's own signature (#608), which set_stationery and set_letter_words draw again.
        'stationery', 'signature_image']) {
        expect(sql, column).toContain(column);
      }
      expect(sql).toMatch(/WHERE draft_id = \$1 AND user_id = \$2/);
      expect(params).toEqual(['draft-1', 'auth0|owner']);
    });

    it("is null for a draft that is not the caller's, or not there", async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);
      await expect(getDraftForStationery('draft-1', 'auth0|owner')).resolves.toBeNull();
    });
  });

  describe('setDraftStationery', () => {
    it('locks the draft as setDraftSchedule does, restyles it, and remembers the theme, in one transaction', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [DRAWN] });

      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: { ...BOTANICAL, source: 'asked' } as any, previewHtml: PAGE, drawnFrom: WORDS }, NOW)
      ).resolves.toBeNull();

      const [lock, live, read, update, remember] = client.query.mock.calls as Array<[string, unknown[]]>;
      expect(lock[0]).toMatch(/FROM letter_drafts WHERE draft_id = \$1 AND user_id = \$2 FOR UPDATE/);
      expect(live[0]).toMatch(/FROM orders/);
      expect(live[1]).toEqual(['draft-1', [...LIVE_PAY_AND_SEND_STATUSES]]);
      // What the page was drawn from, read again under the lock (#586).
      expect(read).toEqual(['SELECT body_text, sign_off, stationery, signature_image FROM letter_drafts WHERE draft_id = $1', ['draft-1']]);
      expect(update[0]).toMatch(
        /UPDATE letter_drafts\s+SET stationery = \$2::jsonb,\s+renderer_version = CASE WHEN signature_image IS NOT NULL THEN 'pdf-4' ELSE \$3::text END,\s+preview_html = \$4,\s+pages = COALESCE\(\$5::smallint, pages\), updated_at = NOW\(\)\s+WHERE draft_id = \$1/
      );
      // A signed draft keeps pdf-4 whatever the theme (#608, 051's pair): the
      // row's own signature decides, read under the lock.
      // Stored as the print reads it back: the theme and its slots, not why it was chosen.
      // No pages given: the draft keeps its own (#586).
      expect(update[1]).toEqual(['draft-1', JSON.stringify(BOTANICAL), 'pdf-2', PAGE, null]);
      // Never on an erased account (#571 review round 3).
      expect(remember[0]).toBe('UPDATE users SET stationery_theme = $2 WHERE user_id = $1 AND erased_at IS NULL');
      expect(remember[1]).toEqual(['auth0|owner', 'botanical']);
      expect(client.query).toHaveBeenCalledTimes(5);
    });

    it('stores Classic as none, with pdf-1, and remembers Classic like any theme', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [DRAWN] });

      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: { theme: 'classic' }, previewHtml: PAGE, drawnFrom: WORDS }, NOW)
      ).resolves.toBeNull();

      expect(client.query.mock.calls[3][1]).toEqual(['draft-1', null, 'pdf-1', PAGE, null]);
      expect(client.query.mock.calls[4][1]).toEqual(['auth0|owner', 'classic']);
    });

    it('stores the pages a restyle laid the letter out on (#586)', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [DRAWN] });
      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: { ...BOTANICAL } as any, previewHtml: PAGE, pages: 2, drawnFrom: WORDS }, NOW)
      ).resolves.toBeNull();
      expect(client.query.mock.calls[3][1]).toEqual(['draft-1', JSON.stringify(BOTANICAL), 'pdf-2', PAGE, 2]);
    });

    it.each([
      ['its body', { body_text: 'Dear Sam, and more,' }],
      ['its sign-off', { sign_off: 'Love, Pat' }],
      ['its sign-off, gone', { sign_off: null }]
    ])('refuses a restyle drawn from words that changed under it: %s (#586)', async (_label, changed) => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, ...changed }] });
      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: BOTANICAL, previewHtml: PAGE, pages: 2, drawnFrom: WORDS }, NOW)
      ).resolves.toBe('changed');
      // Nothing written, nothing remembered.
      expect(client.query).toHaveBeenCalledTimes(3);
    });

    it('takes a sign-off stored as none as the none it was drawn from', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, sign_off: null }] });
      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: BOTANICAL, previewHtml: PAGE, drawnFrom: { ...WORDS, signOff: null } }, NOW)
      ).resolves.toBeNull();
      expect(client.query).toHaveBeenCalledTimes(5);
    });

    it.each([
      ['a missing draft, or one that is not the caller\'s', [{ rows: [] }], 'not_found', 1],
      ['a sent draft', [{ rows: [{ ...pending, status: 'consumed' }] }], 'sent', 1],
      ['a pending draft past its expiry', [{ rows: [{ ...pending, expires_at: NOW }] }], 'expired', 1],
      ['a draft an erasure emptied', [{ rows: [{ ...pending, redacted_at: NOW }] }], 'expired', 1],
      ['a sent draft the sweep emptied', [{ rows: [{ ...pending, status: 'consumed', redacted_at: NOW }] }], 'sent', 1],
      ['a draft with a live Pay & Send order', [{ rows: [pending] }, { rows: [{ '?column?': 1 }] }], 'checkout_pending', 2]
    ])('leaves %s alone, remembering nothing', async (_label, answers, refusal, statements) => {
      const client = inTransaction(...(answers as Array<{ rows: unknown[] }>));

      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: BOTANICAL, previewHtml: PAGE, drawnFrom: WORDS }, NOW)
      ).resolves.toBe(refusal);

      expect(client.query).toHaveBeenCalledTimes(statements);
    });

    it('refuses a theme the print would not read back before any statement', async () => {
      const client = inTransaction();
      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: { theme: 'floral' } as any, previewHtml: PAGE, drawnFrom: WORDS }, NOW)
      ).rejects.toMatchObject({ code: 'STATIONERY_UNREADABLE', diagnosticClass: 'validation_error' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(client.query).not.toHaveBeenCalled();
    });
  });

  describe('setDraftSignature (#608 part 4)', () => {
    const SIGNED = 'data:image/png;base64,iVBORw0KGgo=';
    const drawnFrom = (signature: string | null) => ({ words: WORDS, stationery: null, signature });

    it.each([
      ['signs', SIGNED, null, true],
      ['unsigns', null, SIGNED, false]
    ] as const)('%s the draft under the lock a restyle takes, with the version its row needs, and remembers the choice', async (_label, image, before, remembered) => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, signature_image: before }] });

      await expect(
        setDraftSignature('draft-1', 'auth0|owner', { signatureImage: image, previewHtml: PAGE, pages: 1, drawnFrom: drawnFrom(before) }, NOW)
      ).resolves.toBeNull();

      const [lock, live, read, update, remember] = client.query.mock.calls as Array<[string, unknown[]]>;
      expect(lock[0]).toMatch(/FROM letter_drafts WHERE draft_id = \$1 AND user_id = \$2 FOR UPDATE/);
      expect(live[0]).toMatch(/FROM orders/);
      expect(read).toEqual(['SELECT body_text, sign_off, stationery, signature_image FROM letter_drafts WHERE draft_id = $1', ['draft-1']]);
      // The version from the row's own stationery, under the lock, so 044's and 051's pairs hold.
      expect(update[0]).toMatch(
        /UPDATE letter_drafts\s+SET signature_image = \$2::text,\s+renderer_version = CASE WHEN \$2::text IS NOT NULL THEN 'pdf-4'\s+WHEN stationery IS NOT NULL THEN 'pdf-2'\s+ELSE 'pdf-1' END,\s+preview_html = \$3,\s+pages = \$4::smallint, updated_at = NOW\(\)\s+WHERE draft_id = \$1/
      );
      expect(update[1]).toEqual(['draft-1', image, PAGE, 1]);
      expect(remember).toEqual(['UPDATE user_signatures SET use_by_default = $2 WHERE user_id = $1', ['auth0|owner', remembered]]);
      expect(client.query).toHaveBeenCalledTimes(5);
    });

    it.each([
      ['its signature', { signature_image: SIGNED }],
      ['its words', { body_text: 'Dear Ruth,' }],
      ['its stationery', { stationery: BOTANICAL }]
    ])('refuses as changed when %s changed since the page was drawn, writing nothing', async (_label, changed) => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, signature_image: null, ...changed }] });
      await expect(
        setDraftSignature('draft-1', 'auth0|owner', { signatureImage: SIGNED, previewHtml: PAGE, pages: 1, drawnFrom: drawnFrom(null) }, NOW)
      ).resolves.toBe('changed');
      expect(client.query).toHaveBeenCalledTimes(3);
    });

    it('refuses a restyle or new words drawn with a signature the draft no longer has (#608)', async () => {
      let client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, signature_image: SIGNED }] });
      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: { ...BOTANICAL, source: 'asked' } as any, previewHtml: PAGE, drawnFrom: { ...WORDS, signature: null } }, NOW)
      ).resolves.toBe('changed');
      expect(client.query).toHaveBeenCalledTimes(3);

      client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, signature_image: null }] });
      await expect(
        setDraftWords('draft-1', 'auth0|owner', {
          bodyText: 'Dear Sam,\n\nNew words.', signOff: 'Pat', previewHtml: PAGE, pages: 1, drawnIn: null,
          replacing: WORDS, drawnWith: SIGNED
        }, NOW)
      ).resolves.toBe('changed');
      expect(client.query).toHaveBeenCalledTimes(3);

      // A restyle that names no signature does not compare it, as before.
      client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, signature_image: SIGNED }] });
      await expect(
        setDraftStationery('draft-1', 'auth0|owner', { stationery: { ...BOTANICAL, source: 'asked' } as any, previewHtml: PAGE, drawnFrom: WORDS }, NOW)
      ).resolves.toBeNull();
    });
  });

  describe('setDraftWords (#586)', () => {
    it.each([
      ['its body', { body_text: 'Dear Sam, changed on the card,' }],
      ['its sign-off', { sign_off: 'Love, Pat' }]
    ])('refuses new words when the words they replace changed under them: %s (#593 review round 1)', async (_label, changed) => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, ...changed }] });
      await expect(
        setDraftWords('draft-1', 'auth0|owner', { bodyText: 'New', signOff: 'Pat', previewHtml: PAGE, pages: 1, drawnIn: null, replacing: WORDS }, NOW)
      ).resolves.toBe('changed');
      expect(client.query).toHaveBeenCalledTimes(3);
    });

    // The words it replaces, as the tool read them (#593 review round 1).
    const NEW = { bodyText: 'Dear Sam, the garden is in.', signOff: 'Love, Pat', previewHtml: PAGE, pages: 2, replacing: WORDS };

    it('locks the draft as a restyle does, checks the stationery it was drawn in, and writes the words, page and pages in one statement', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, stationery: BOTANICAL }] });

      await expect(setDraftWords('draft-1', 'auth0|owner', { ...NEW, drawnIn: { ...BOTANICAL } }, NOW)).resolves.toBeNull();

      const [lock, live, read, update] = client.query.mock.calls as Array<[string, unknown[]]>;
      expect(lock[0]).toMatch(/FROM letter_drafts WHERE draft_id = \$1 AND user_id = \$2 FOR UPDATE/);
      expect(live[0]).toMatch(/FROM orders/);
      expect(read).toEqual(['SELECT body_text, sign_off, stationery, signature_image FROM letter_drafts WHERE draft_id = $1', ['draft-1']]);
      expect(update[0]).toMatch(
        /UPDATE letter_drafts\s+SET body_text = \$2, sign_off = \$3, preview_html = \$4, pages = \$5::smallint, updated_at = NOW\(\)\s+WHERE draft_id = \$1/
      );
      expect(update[1]).toEqual(['draft-1', NEW.bodyText, NEW.signOff, PAGE, 2]);
      // Nothing remembered: the words are this letter's only.
      expect(client.query).toHaveBeenCalledTimes(4);
    });

    it('writes words drawn on a plain page, stored as no stationery', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [DRAWN] });
      await expect(setDraftWords('draft-1', 'auth0|owner', { ...NEW, pages: 1, drawnIn: null }, NOW)).resolves.toBeNull();
      expect(client.query.mock.calls[3][1]).toEqual(['draft-1', NEW.bodyText, NEW.signOff, PAGE, 1]);
    });

    it.each([
      ['restyled', { stationery: { theme: 'typewriter', dateLine: 'October 1, 2026' } }, BOTANICAL],
      ['given a date line again', { stationery: { ...BOTANICAL, dateLine: 'October 2, 2026' } }, BOTANICAL],
      ['put back on a plain page', { stationery: null }, BOTANICAL],
      ['given a theme', { stationery: BOTANICAL }, null]
    ])('refuses words drawn in stationery that was %s under them', async (_label, changed, drawnIn) => {
      // (#593 review round 1: the words they replace are as read here.)
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, ...changed }] });
      await expect(setDraftWords('draft-1', 'auth0|owner', { ...NEW, drawnIn }, NOW)).resolves.toBe('changed');
      expect(client.query).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['a missing draft, or one that is not the caller\'s', [{ rows: [] }], 'not_found', 1],
      ['a sent draft', [{ rows: [{ ...pending, status: 'consumed' }] }], 'sent', 1],
      ['a pending draft past its expiry', [{ rows: [{ ...pending, expires_at: NOW }] }], 'expired', 1],
      ['a draft an erasure emptied', [{ rows: [{ ...pending, redacted_at: NOW }] }], 'expired', 1],
      ['a draft with a live Pay & Send order', [{ rows: [pending] }, { rows: [{ '?column?': 1 }] }], 'checkout_pending', 2]
    ])('leaves %s alone', async (_label, answers, refusal, statements) => {
      const client = inTransaction(...(answers as Array<{ rows: unknown[] }>));
      await expect(setDraftWords('draft-1', 'auth0|owner', { ...NEW, drawnIn: null }, NOW)).resolves.toBe(refusal);
      expect(client.query).toHaveBeenCalledTimes(statements);
    });
  });
});

describe('draftService postcard style (#594)', () => {
  const NOW = new Date('2026-10-02T14:00:00Z');
  const pending = { status: 'pending', expires_at: new Date('2026-10-03T09:00:00Z') };
  const PAGE = '<!DOCTYPE html><html><body data-renderer="pdf-1"><svg></svg><svg></svg></body></html>';
  const BEFORE = '<!DOCTYPE html><html><body data-renderer="pdf-1"><svg>before</svg><svg></svg></body></html>';
  const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');
  // The preview the restyle drew from, as the lock reads it again.
  const DRAWN = { preview_md5: md5(BEFORE), is_gift_send: false };
  const BORDER = { layout: 'border' as const, caption: 'Cape Cod' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A transaction whose statements answer in turn; the client is returned to read its calls. */
  function inTransaction(...answers: Array<{ rows: unknown[] }>) {
    const client = { query: vi.fn() };
    for (const answer of answers) client.query.mockResolvedValueOnce(answer);
    client.query.mockResolvedValue({ rows: [], rowCount: 1 });
    vi.mocked(db.transaction).mockImplementation(async callback => callback(client as any));
    return client;
  }

  describe('getDraftForPostcardStyle', () => {
    it("reads the caller's draft with what it is drawn again from", async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ mail_type: 'postcard' }] } as any);
      await expect(getDraftForPostcardStyle('draft-1', 'auth0|owner')).resolves.toEqual({ mail_type: 'postcard' });
      const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
      for (const column of ['mail_type', 'status', 'expires_at', 'redacted_at', 'renderer_version', 'body_text', 'sender', 'recipient',
        'front_image_data', 'front_image_url', 'postcard_size', 'postcard_front', 'preview_html', 'is_gift_send', 'required_credits']) {
        expect(sql, column).toContain(column);
      }
      expect(sql).toMatch(/WHERE draft_id = \$1 AND user_id = \$2/);
      expect(params).toEqual(['draft-1', 'auth0|owner']);
    });

    it("is null for a draft that is not the caller's, or not there", async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as any);
      await expect(getDraftForPostcardStyle('draft-1', 'auth0|owner')).resolves.toBeNull();
    });
  });

  describe('getDraftState', () => {
    it("reads a postcard's size and front, and the page of any draft our renderer drew", async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ draft_id: 'draft-1' }] } as any);
      await getDraftState('draft-1');
      const [sql] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('d.postcard_size, d.postcard_front');
      expect(sql).toMatch(/CASE WHEN d\.status = 'pending' AND d\.renderer_version IS NOT NULL\s+THEN d\.preview_html END AS preview_html/);
      // Whether it is signed (#608), never the picture: an emptied copy reads as unsigned.
      expect(sql).toContain("(d.signature_image IS NOT NULL AND d.signature_image <> '') AS signed");
      expect(sql).not.toMatch(/d\.signature_image(,|\s+FROM)/);
    });
  });

  describe('setDraftPostcardStyle', () => {
    it('locks the draft as setDraftSchedule does, checks what it was drawn from, and restyles it', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [DRAWN] });
      await expect(
        setDraftPostcardStyle(
          'draft-1',
          'auth0|owner',
          { size: '6x11', front: BORDER, previewHtml: PAGE, frontImageData: 'data:image/jpeg;base64,AAAA', drawnFrom: { previewHtml: BEFORE } },
          NOW
        )
      ).resolves.toBeNull();

      const [lock, live, read, update] = client.query.mock.calls as Array<[string, unknown[]]>;
      expect(lock[0]).toMatch(/FROM letter_drafts WHERE draft_id = \$1 AND user_id = \$2 FOR UPDATE/);
      expect(live[0]).toMatch(/FROM orders/);
      expect(live[1]).toEqual(['draft-1', [...LIVE_PAY_AND_SEND_STATUSES]]);
      expect(read).toEqual(['SELECT md5(preview_html) AS preview_md5, is_gift_send FROM letter_drafts WHERE draft_id = $1', ['draft-1']]);
      expect(update[0]).toMatch(
        /UPDATE letter_drafts\s+SET postcard_size = \$2, postcard_front = \$3::jsonb, renderer_version = \$4, preview_html = \$5,\s+front_image_data = COALESCE\(\$6, front_image_data\), updated_at = NOW\(\)\s+WHERE draft_id = \$1/
      );
      // The front as the print reads it back, with the version 048 pairs it with.
      expect(update[1]).toEqual(['draft-1', '6x11', JSON.stringify(BORDER), 'pdf-3', PAGE, 'data:image/jpeg;base64,AAAA']);
      expect(client.query).toHaveBeenCalledTimes(4);
    });

    it('stores full bleed as no front, with pdf-1, and keeps the picture when none is given', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [DRAWN] });
      await expect(
        setDraftPostcardStyle('draft-1', 'auth0|owner', { size: '6x9', front: null, previewHtml: PAGE, drawnFrom: { previewHtml: BEFORE } }, NOW)
      ).resolves.toBeNull();
      expect(client.query.mock.calls[3][1]).toEqual(['draft-1', '6x9', null, 'pdf-1', PAGE, null]);
    });

    it.each([
      ['its preview changed under it', { ...DRAWN, preview_md5: md5(PAGE) }, '6x9'],
      ['its preview is gone', { ...DRAWN, preview_md5: null }, '6x9'],
      ['a gift postcard asked off 6x9', { ...DRAWN, is_gift_send: true }, '6x4']
    ] as const)('refuses a restyle when %s, writing nothing', async (_label, row, size) => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [row] });
      await expect(
        setDraftPostcardStyle('draft-1', 'auth0|owner', { size, front: null, previewHtml: PAGE, drawnFrom: { previewHtml: BEFORE } }, NOW)
      ).resolves.toBe('changed');
      expect(client.query).toHaveBeenCalledTimes(3);
    });

    it('restyles a gift postcard that stays a 6x9', async () => {
      const client = inTransaction({ rows: [pending] }, { rows: [] }, { rows: [{ ...DRAWN, is_gift_send: true }] });
      await expect(
        setDraftPostcardStyle('draft-1', 'auth0|owner', { size: '6x9', front: BORDER, previewHtml: PAGE, drawnFrom: { previewHtml: BEFORE } }, NOW)
      ).resolves.toBeNull();
      expect(client.query).toHaveBeenCalledTimes(4);
    });

    it.each([
      ["a missing draft, or one that is not the caller's", [{ rows: [] }], 'not_found', 1],
      ['a sent draft', [{ rows: [{ ...pending, status: 'consumed' }] }], 'sent', 1],
      ['a pending draft past its expiry', [{ rows: [{ ...pending, expires_at: NOW }] }], 'expired', 1],
      ['a draft an erasure emptied', [{ rows: [{ ...pending, redacted_at: NOW }] }], 'expired', 1],
      ['a draft with a live Pay & Send order', [{ rows: [pending] }, { rows: [{ '?column?': 1 }] }], 'checkout_pending', 2]
    ])('leaves %s alone', async (_label, answers, refusal, statements) => {
      const client = inTransaction(...(answers as Array<{ rows: unknown[] }>));
      await expect(
        setDraftPostcardStyle('draft-1', 'auth0|owner', { size: '6x9', front: BORDER, previewHtml: PAGE, drawnFrom: { previewHtml: BEFORE } }, NOW)
      ).resolves.toBe(refusal);
      expect(client.query).toHaveBeenCalledTimes(statements);
    });

    it('refuses a front the print would not read back before any statement', async () => {
      const client = inTransaction();
      await expect(
        setDraftPostcardStyle(
          'draft-1',
          'auth0|owner',
          { size: '6x9', front: { layout: 'greetings' } as any, previewHtml: PAGE, drawnFrom: { previewHtml: BEFORE } },
          NOW
        )
      ).rejects.toMatchObject({ code: 'POSTCARD_FRONT_UNREADABLE', diagnosticClass: 'validation_error' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(client.query).not.toHaveBeenCalled();
    });
  });
});

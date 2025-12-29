/**
 * Unit tests for get_order_status tool - Response Optimization
 *
 * Tests that the tool response does not include large preview HTML data
 * to reduce payload size and avoid base64 image data in model context.
 *
 * User Stories Covered:
 * - US-LETTER-04: Check Letter Status (Response Optimization section)
 *
 * Personas Covered:
 * - Marcus (Regular Correspondent) - checks status frequently
 * - Eleanor (Elderly User) - wants to know if letter was sent
 *
 * GitHub Issue: #83
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, OrderRecord, UserState } from '../../../src/contracts/types.js';

// Import the handler function from the tool
// Note: We test the handler directly rather than mocking the tool definition
import { getOrderStatusTool } from '../../../src/tools/getOrderStatus.js';

// Test fixtures
const createMockOrder = (orderId: string, withPreview: boolean = true): OrderRecord => ({
  orderId,
  currentStatus: 'queued_for_print',
  statusTimeline: [
    { timestampISO: '2025-12-29T10:00:00Z', statusText: 'Letter received' },
    { timestampISO: '2025-12-29T10:00:01Z', statusText: 'Queued for printing' },
  ],
  recipientSummary: {
    name: 'Jane Recipient',
    city: 'Los Angeles',
    state: 'CA',
  },
  // This field contains the base64 image data that should NOT be returned
  previewFirstPageHtml: withPreview
    ? '<div style="padding:1rem"><img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD..." /></div>'
    : undefined,
});

const createMockContext = (orders: OrderRecord[]): ToolContext => {
  const user: UserState = {
    userId: 'test-user-id',
    email: 'test@example.com',
    creditsRemaining: 10,
    orders,
    activeQuote: null,
  };

  return {
    user,
    correlationId: 'test-correlation-id',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any,
    now: () => new Date('2025-12-29T12:00:00Z'),
    persist: vi.fn(),
  };
};

describe('get_order_status tool', () => {
  describe('Response Optimization (US-LETTER-04)', () => {
    it('should NOT include previewThumbnailHtml in response', async () => {
      // Arrange
      const mockOrder = createMockOrder('order-123', true);
      const context = createMockContext([mockOrder]);

      // Act
      const result = await getOrderStatusTool.handler({ orderId: 'order-123' }, context);

      // Assert
      expect(result).not.toHaveProperty('previewThumbnailHtml');
    });

    it('should NOT include base64 image data in response', async () => {
      // Arrange
      const mockOrder = createMockOrder('order-123', true);
      const context = createMockContext([mockOrder]);

      // Act
      const result = await getOrderStatusTool.handler({ orderId: 'order-123' }, context);

      // Assert - stringify the entire response and check for base64
      const responseString = JSON.stringify(result);
      expect(responseString).not.toContain('data:image');
      expect(responseString).not.toContain('base64');
    });

    it('should still return essential status fields', async () => {
      // Arrange
      const mockOrder = createMockOrder('order-123', true);
      const context = createMockContext([mockOrder]);

      // Act
      const result = await getOrderStatusTool.handler({ orderId: 'order-123' }, context);

      // Assert - all essential fields should be present
      expect(result.orderId).toBe('order-123');
      expect(result.currentStatus).toBe('queued_for_print');
      expect(result.statusTimeline).toHaveLength(2);
      expect(result.recipientSummary).toEqual({
        name: 'Jane Recipient',
        city: 'Los Angeles',
        state: 'CA',
      });
    });

    it('should include canSendFollowUp and followUpSuggestedPrompt', async () => {
      // Arrange
      const mockOrder = createMockOrder('order-123', true);
      const context = createMockContext([mockOrder]);

      // Act
      const result = await getOrderStatusTool.handler({ orderId: 'order-123' }, context);

      // Assert
      expect(result.canSendFollowUp).toBe(true);
      expect(result.followUpSuggestedPrompt).toContain('Jane Recipient');
    });
  });

  describe('Order Selection', () => {
    it('should return most recent order when no orderId provided', async () => {
      // Arrange
      const olderOrder = createMockOrder('order-old');
      olderOrder.statusTimeline = [
        { timestampISO: '2025-12-28T10:00:00Z', statusText: 'Older letter' },
      ];
      const newerOrder = createMockOrder('order-new');
      newerOrder.statusTimeline = [
        { timestampISO: '2025-12-29T10:00:00Z', statusText: 'Newer letter' },
      ];
      const context = createMockContext([olderOrder, newerOrder]);

      // Act
      const result = await getOrderStatusTool.handler({}, context);

      // Assert
      expect(result.orderId).toBe('order-new');
    });

    it('should throw error when no orders found', async () => {
      // Arrange
      const context = createMockContext([]);

      // Act & Assert
      await expect(
        getOrderStatusTool.handler({}, context)
      ).rejects.toThrow('No matching order found for this user');
    });

    it('should throw error when specified orderId not found', async () => {
      // Arrange
      const mockOrder = createMockOrder('order-123');
      const context = createMockContext([mockOrder]);

      // Act & Assert
      await expect(
        getOrderStatusTool.handler({ orderId: 'nonexistent-order' }, context)
      ).rejects.toThrow('No matching order found for this user');
    });
  });
});

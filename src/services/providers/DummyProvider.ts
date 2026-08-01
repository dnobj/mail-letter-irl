/**
 * Dummy Letter Fulfillment Provider
 *
 * A mock provider for testing that simulates letter sending without
 * actually calling any external APIs. Useful for:
 * - Development and testing
 * - Simulating success/failure scenarios
 * - Testing retry logic
 * - Load testing without costs
 */

import { randomUUID } from 'crypto';
import type {
  LetterFulfillmentProvider,
  LetterParams,
  LetterResult,
  LetterStatus,
  CostEstimate,
  ProviderConfig
} from './types.js';

export interface DummyProviderOptions {
  /** Simulated delay in milliseconds (default: 1000ms) */
  delayMs?: number;

  /** Probability of failure (0-1, default: 0.05 = 5%) */
  failureRate?: number;

  /** Simulated cost per letter in cents (default: 100 = $1.00) */
  costCents?: number;

  /** Simulated delivery time in days (default: 3) */
  deliveryDays?: number;

  /** Whether to log operations (default: true) */
  verbose?: boolean;
}

/**
 * In-memory storage for dummy letter tracking
 */
const letterStore = new Map<string, {
  params: LetterParams;
  sentAt: Date;
  status: LetterStatus['status'];
  deliveryDate: Date;
}>();

export class DummyProvider implements LetterFulfillmentProvider {
  public readonly config: ProviderConfig;
  private options: Required<DummyProviderOptions>;

  constructor(config: ProviderConfig, options: DummyProviderOptions = {}) {
    this.config = config;
    this.options = {
      delayMs: options.delayMs ?? 1000,
      failureRate: options.failureRate ?? 0.05,
      costCents: options.costCents ?? 100,
      deliveryDays: options.deliveryDays ?? 3,
      verbose: options.verbose ?? true
    };

    if (this.options.verbose) {
      console.log(`✅ DummyProvider initialized`);
      console.log(`   Delay: ${this.options.delayMs}ms`);
      console.log(`   Failure Rate: ${(this.options.failureRate * 100).toFixed(1)}%`);
      console.log(`   Cost: $${(this.options.costCents / 100).toFixed(2)}`);
      console.log(`   Delivery Time: ${this.options.deliveryDays} days`);
    }
  }

  /**
   * Simulate sending a letter
   */
  async sendLetter(params: LetterParams): Promise<LetterResult> {
    const trackingId = `DUMMY-${randomUUID()}`;

    if (this.options.verbose) {
      console.log('📤 [DummyProvider] Sending letter');
    }

    // Simulate network delay
    await this.delay(this.options.delayMs);

    // Simulate random failures
    if (Math.random() < this.options.failureRate) {
      const error = `Simulated provider failure (${(this.options.failureRate * 100).toFixed(0)}% chance)`;

      if (this.options.verbose) {
        console.log('❌ [DummyProvider] Simulated provider failure');
      }

      return {
        success: false,
        trackingId,
        error
      };
    }

    // Calculate delivery date
    const deliveryDate = new Date();
    deliveryDate.setDate(deliveryDate.getDate() + this.options.deliveryDays);

    // Store letter in memory
    letterStore.set(trackingId, {
      params,
      sentAt: new Date(),
      status: 'accepted',
      deliveryDate
    });

    // Schedule status transitions (simulated)
    this.scheduleStatusTransitions(trackingId, deliveryDate);

    if (this.options.verbose) {
      console.log(`✅ [DummyProvider] Letter queued successfully`);
      console.log(`   Expected delivery: ${deliveryDate.toLocaleDateString()}`);
    }

    return {
      success: true,
      trackingId,
      expectedDeliveryDate: deliveryDate,
      costCents: this.options.costCents,
      detailsUrl: `https://dummy-provider.example.com/track/${trackingId}`,
      metadata: {
        provider: 'dummy',
        simulatedDelay: this.options.delayMs,
        messageLength: params.message.length
      }
    };
  }

  /**
   * Get delivery status of a letter
   */
  async getStatus(trackingId: string): Promise<LetterStatus> {
    const letter = letterStore.get(trackingId);

    if (!letter) {
      throw new Error(`Letter not found: ${trackingId}`);
    }

    const now = new Date();
    const timeSinceSent = now.getTime() - letter.sentAt.getTime();
    const totalDeliveryTime = letter.deliveryDate.getTime() - letter.sentAt.getTime();
    const progress = timeSinceSent / totalDeliveryTime;

    // Simulate realistic status progression
    let currentStatus: LetterStatus['status'];
    let statusMessage: string;

    if (progress < 0.1) {
      currentStatus = 'accepted';
      statusMessage = 'Letter accepted by print facility';
    } else if (progress < 0.3) {
      currentStatus = 'processing';
      statusMessage = 'Letter is being printed';
    } else if (progress < 1.0) {
      currentStatus = 'in_transit';
      statusMessage = 'Letter is in transit to recipient';
    } else {
      currentStatus = 'delivered';
      statusMessage = 'Letter has been delivered';
    }

    // Update stored status
    letter.status = currentStatus;

    return {
      trackingId,
      status: currentStatus,
      statusMessage,
      lastUpdated: new Date(),
      deliveredAt: currentStatus === 'delivered' ? letter.deliveryDate : undefined,
      events: this.generateTrackingEvents(letter.sentAt, letter.deliveryDate, currentStatus)
    };
  }

  /**
   * Estimate cost for a letter
   */
  async estimateCost(params: LetterParams): Promise<CostEstimate> {
    // Simulate delay
    await this.delay(100);

    const baseCost = this.options.costCents * 0.5; // 50% for printing/handling
    const postageCost = this.options.costCents * 0.3; // 30% for postage
    const servicesCost = this.options.costCents * 0.2; // 20% for services

    return {
      baseCostCents: Math.round(baseCost),
      postageCents: Math.round(postageCost),
      servicesCents: Math.round(servicesCost),
      totalCents: this.options.costCents,
      breakdown: [
        { item: 'Printing & Handling', costCents: Math.round(baseCost) },
        { item: 'First-Class Postage', costCents: Math.round(postageCost) },
        { item: 'Processing Fee', costCents: Math.round(servicesCost) }
      ]
    };
  }

  /**
   * Cancel a queued letter (if not yet processed)
   */
  async cancelLetter(trackingId: string): Promise<boolean> {
    const letter = letterStore.get(trackingId);

    if (!letter) {
      return false;
    }

    if (letter.status === 'queued' || letter.status === 'processing') {
      letterStore.delete(trackingId);

      if (this.options.verbose) {
        console.log('🚫 [DummyProvider] Letter cancelled');
      }

      return true;
    }

    if (this.options.verbose) {
      console.log(`⚠️  [DummyProvider] Cannot cancel letter in status: ${letter.status}`);
    }

    return false;
  }

  /**
   * Validate provider connection (always succeeds for dummy)
   */
  async validateConnection(): Promise<boolean> {
    await this.delay(500);

    if (this.options.verbose) {
      console.log(`✅ [DummyProvider] Connection validated`);
    }

    return true;
  }

  /**
   * Simulate delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Schedule realistic status transitions over time
   * (In a real app, this would be handled by the provider's webhooks)
   */
  private scheduleStatusTransitions(trackingId: string, deliveryDate: Date): void {
    const letter = letterStore.get(trackingId);
    if (!letter) return;

    const now = new Date();
    const deliveryTime = deliveryDate.getTime() - now.getTime();

    // Queue → Processing (10% of delivery time)
    setTimeout(() => {
      const l = letterStore.get(trackingId);
      if (l) l.status = 'processing';
    }, deliveryTime * 0.1);

    // Processing → In Transit (30% of delivery time)
    setTimeout(() => {
      const l = letterStore.get(trackingId);
      if (l) l.status = 'in_transit';
    }, deliveryTime * 0.3);

    // In Transit → Delivered (100% of delivery time)
    setTimeout(() => {
      const l = letterStore.get(trackingId);
      if (l) l.status = 'delivered';
    }, deliveryTime);
  }

  /**
   * Generate realistic tracking events
   */
  private generateTrackingEvents(
    sentAt: Date,
    deliveryDate: Date,
    currentStatus: LetterStatus['status']
  ): LetterStatus['events'] {
    const events: LetterStatus['events'] = [];
    const now = new Date();

    events.push({
      timestamp: sentAt,
      status: 'accepted',
      message: 'Letter accepted by print facility',
      location: 'Processing Center'
    });

    if (currentStatus === 'processing' || currentStatus === 'in_transit' || currentStatus === 'delivered') {
      const processingTime = new Date(sentAt.getTime() + (deliveryDate.getTime() - sentAt.getTime()) * 0.1);
      events.push({
        timestamp: processingTime,
        status: 'processing',
        message: 'Letter is being printed',
        location: 'Print Facility'
      });
    }

    if (currentStatus === 'in_transit' || currentStatus === 'delivered') {
      const transitTime = new Date(sentAt.getTime() + (deliveryDate.getTime() - sentAt.getTime()) * 0.3);
      events.push({
        timestamp: transitTime,
        status: 'in_transit',
        message: 'Letter picked up by USPS',
        location: 'Local Post Office'
      });
    }

    if (currentStatus === 'delivered') {
      events.push({
        timestamp: deliveryDate,
        status: 'delivered',
        message: 'Letter delivered to recipient',
        location: 'Delivered'
      });
    }

    return events;
  }

  /**
   * Clear all stored letters (useful for testing)
   */
  static clearStore(): void {
    letterStore.clear();
    console.log('🗑️  [DummyProvider] Cleared letter store');
  }

  /**
   * Get all stored letters (useful for debugging)
   */
  static getStore(): Map<string, any> {
    return new Map(letterStore);
  }
}

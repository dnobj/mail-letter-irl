/**
 * DIY Letter Fulfillment Provider
 *
 * Minimal provider that marks letters for manual fulfillment.
 * Letters are picked up by the letter-irl-diy dashboard via shared database.
 *
 * Flow:
 * 1. letterWorker calls sendLetter() - we return success
 * 2. letterWorker writes provider='diy' to database
 * 3. letter-irl-diy dashboard queries WHERE provider='diy' to show pending orders
 * 4. You print, mail, and update status via dashboard
 */

import type {
  LetterFulfillmentProvider,
  LetterParams,
  LetterResult,
  LetterStatus,
  CostEstimate,
  ProviderConfig,
} from './types.js';

export class DIYProvider implements LetterFulfillmentProvider {
  public readonly config: ProviderConfig;
  private verbose: boolean;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.verbose = config.config?.verbose ?? true;

    if (this.verbose) {
      console.log(`✅ DIYProvider initialized (database-only, no external service)`);
    }
  }

  /**
   * Mark letter for DIY fulfillment
   *
   * Just returns success - letterWorker handles writing to database.
   * The letter-irl-diy dashboard will pick it up from the shared database.
   */
  async sendLetter(params: LetterParams): Promise<LetterResult> {
    const letterId = params.metadata?.letterId;

    if (this.verbose) {
      console.log(`📤 [DIY] Queuing letter ${letterId} to ${params.recipientName} for manual fulfillment`);
    }

    // Estimate delivery: 7-10 business days for manual processing
    const expectedDelivery = new Date();
    expectedDelivery.setDate(expectedDelivery.getDate() + 10);

    return {
      success: true,
      trackingId: `DIY-${letterId}`,
      expectedDeliveryDate: expectedDelivery,
      costCents: this.estimateCost(params),
      metadata: {
        provider: 'diy',
        letterId,
        note: 'Check letter-irl-diy dashboard for printing',
      },
    };
  }

  /**
   * Get delivery status
   *
   * Status is managed via the letter-irl-diy dashboard and stored in shared database.
   * This method would need to query the database directly.
   */
  async getStatus(trackingId: string): Promise<LetterStatus> {
    // For DIY, status is managed in the shared database
    // The admin panel and dashboard already show this
    return {
      trackingId,
      status: 'queued',
      statusMessage: 'Check letter-irl-diy dashboard for current status',
      lastUpdated: new Date(),
      events: [],
    };
  }

  /**
   * Estimate cost for DIY letter
   */
  async estimateCost(params: LetterParams): Promise<CostEstimate> {
    const totalCents = this.calculateCost(params);

    return {
      baseCostCents: 20,
      postageCents: 78,
      servicesCents: params.color ? 10 : 0,
      totalCents,
      breakdown: [
        { item: 'Paper (2 sheets)', costCents: 3 },
        { item: 'Envelope (#10)', costCents: 7 },
        { item: 'Ink/Toner', costCents: 10 },
        { item: 'First-Class Postage', costCents: 78 },
        ...(params.color ? [{ item: 'Color Ink Extra', costCents: 10 }] : []),
      ],
    };
  }

  /**
   * Validate connection - always returns true for DIY (no external service)
   */
  async validateConnection(): Promise<boolean> {
    if (this.verbose) {
      console.log(`✅ [DIY] No external service to validate - using shared database`);
    }
    return true;
  }

  /**
   * Calculate cost
   */
  private calculateCost(params: LetterParams): number {
    let cost = 98; // Base: ~$0.98 (paper, envelope, ink, postage)
    if (params.color) {
      cost += 10;
    }
    return cost;
  }
}

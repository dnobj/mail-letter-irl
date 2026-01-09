/**
 * DIY Letter Fulfillment Provider
 *
 * Thin client that sends letters to the letter-irl-diy service for manual fulfillment.
 * Letters are queued in the DIY dashboard for printing, mailing, and status updates.
 *
 * This provider gives full control over the mail process - useful for:
 * - Testing deliverability before trusting third-party APIs
 * - Low-volume manual fulfillment
 * - Emergency fallback if API providers fail
 */

import type {
  LetterFulfillmentProvider,
  LetterParams,
  LetterResult,
  LetterStatus,
  CostEstimate,
  ProviderConfig,
} from './types.js';

export interface DIYProviderOptions {
  /** DIY service base URL */
  serviceUrl: string;

  /** Admin secret for authentication */
  adminSecret?: string;

  /** Whether to log operations (default: true) */
  verbose?: boolean;
}

export class DIYProvider implements LetterFulfillmentProvider {
  public readonly config: ProviderConfig;
  private options: Required<Omit<DIYProviderOptions, 'adminSecret'>> & { adminSecret?: string };

  constructor(config: ProviderConfig, options: DIYProviderOptions) {
    this.config = config;
    this.options = {
      serviceUrl: options.serviceUrl.replace(/\/$/, ''), // Remove trailing slash
      adminSecret: options.adminSecret,
      verbose: options.verbose ?? true,
    };

    if (this.options.verbose) {
      console.log(`✅ DIYProvider initialized`);
      console.log(`   Service URL: ${this.options.serviceUrl}`);
    }
  }

  /**
   * Send a letter to DIY service for manual fulfillment
   *
   * Note: The letter record should already exist in the database (created by letterWorker).
   * This method notifies the DIY service that it should handle this letter.
   */
  async sendLetter(params: LetterParams): Promise<LetterResult> {
    if (this.options.verbose) {
      console.log(`📤 [DIY] Queuing letter to ${params.recipientName} for manual fulfillment`);
    }

    try {
      // The letter ID should be in the metadata (set by letterWorker)
      const letterId = params.metadata?.letterId;

      if (!letterId) {
        throw new Error('letterId is required in metadata for DIY fulfillment');
      }

      // Notify DIY service about the letter
      const response = await this.apiRequest<{
        success: boolean;
        trackingId: string;
        letterId: number;
        status: string;
      }>('POST', '/orders', { letterId });

      if (this.options.verbose) {
        console.log(`✅ [DIY] Letter queued for manual fulfillment`);
        console.log(`   Tracking ID: ${response.trackingId}`);
        console.log(`   Letter ID: ${response.letterId}`);
      }

      // Estimate delivery: 7-10 business days for manual processing
      const expectedDelivery = new Date();
      expectedDelivery.setDate(expectedDelivery.getDate() + 10);

      return {
        success: true,
        trackingId: response.trackingId,
        expectedDeliveryDate: expectedDelivery,
        costCents: this.estimateCostSync(params),
        metadata: {
          provider: 'diy',
          letterId: response.letterId,
          status: response.status,
        },
      };
    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);

      if (this.options.verbose) {
        console.log(`❌ [DIY] Failed to queue letter: ${errorMessage}`);
      }

      return {
        success: false,
        trackingId: '',
        error: errorMessage,
      };
    }
  }

  /**
   * Get delivery status of a letter
   */
  async getStatus(trackingId: string): Promise<LetterStatus> {
    try {
      // Extract letter ID from tracking ID (format: DIY-123)
      const letterId = trackingId.replace('DIY-', '');

      const response = await this.apiRequest<{
        id: number;
        status: string;
        updated_at: string;
        created_at: string;
      }>('GET', `/orders/${letterId}`);

      const status = this.mapStatus(response.status);

      return {
        trackingId,
        status,
        statusMessage: this.getStatusMessage(response.status),
        lastUpdated: new Date(response.updated_at),
        deliveredAt: status === 'delivered' ? new Date(response.updated_at) : undefined,
        events: [],
      };
    } catch (error) {
      throw new Error(`Failed to get status for ${trackingId}: ${this.extractErrorMessage(error)}`);
    }
  }

  /**
   * Estimate cost for a letter (DIY costs)
   */
  async estimateCost(params: LetterParams): Promise<CostEstimate> {
    const totalCents = this.estimateCostSync(params);

    return {
      baseCostCents: 20, // Paper + envelope (~$0.20)
      postageCents: 78, // First-Class stamp (~$0.78)
      servicesCents: params.color ? 10 : 0, // Color ink extra (~$0.10)
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
   * Validate connection to DIY service
   */
  async validateConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.serviceUrl}/health`);
      const data = await response.json();

      if (this.options.verbose) {
        console.log(`✅ [DIY] Connection validated - service: ${data.service}`);
      }

      return data.status === 'ok';
    } catch (error) {
      if (this.options.verbose) {
        console.log(`❌ [DIY] Connection validation failed: ${this.extractErrorMessage(error)}`);
      }
      return false;
    }
  }

  /**
   * Make API request to DIY service
   */
  private async apiRequest<T>(
    method: 'GET' | 'POST' | 'PATCH',
    endpoint: string,
    body?: any
  ): Promise<T> {
    const url = `${this.options.serviceUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.options.adminSecret) {
      headers['Authorization'] = `Bearer ${this.options.adminSecret}`;
    }

    const requestOptions: RequestInit = {
      method,
      headers,
      ...(body && { body: JSON.stringify(body) }),
    };

    if (this.options.verbose) {
      console.log(`🌐 [DIY] ${method} ${endpoint}`);
    }

    const response = await fetch(url, requestOptions);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Extract error message from various error types
   */
  private extractErrorMessage(error: any): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error?.error) {
      return error.error;
    }
    return 'Unknown error occurred';
  }

  /**
   * Map DIY/database status to standard status
   */
  private mapStatus(dbStatus: string): LetterStatus['status'] {
    const statusMap: Record<string, LetterStatus['status']> = {
      pending: 'queued',
      processing: 'processing',
      in_transit: 'in_transit',
      delivered: 'delivered',
      failed: 'failed',
      returned: 'returned',
    };

    return statusMap[dbStatus.toLowerCase()] || 'queued';
  }

  /**
   * Get human-readable status message
   */
  private getStatusMessage(dbStatus: string): string {
    const messageMap: Record<string, string> = {
      pending: 'Letter is queued for printing',
      processing: 'Letter has been printed, awaiting mailing',
      in_transit: 'Letter has been mailed and is in transit',
      delivered: 'Letter has been delivered',
      failed: 'Letter delivery failed',
      returned: 'Letter was returned to sender',
    };

    return messageMap[dbStatus.toLowerCase()] || `Status: ${dbStatus}`;
  }

  /**
   * Estimate cost synchronously
   */
  private estimateCostSync(params: LetterParams): number {
    let cost = 98; // Base: ~$0.98 (paper, envelope, ink, postage)

    if (params.color) {
      cost += 10; // Color ink extra
    }

    return cost;
  }
}

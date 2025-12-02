/**
 * Letter Fulfillment Service Provider Types
 *
 * Defines the interface that all letter fulfillment providers must implement.
 * This allows swapping between different providers (Lob, PostGrid, etc.) or using
 * a dummy provider for testing.
 */

/**
 * Letter parameters for sending
 */
export interface LetterParams {
  /** Recipient's full name */
  recipientName: string;

  /** Complete mailing address */
  recipientAddress: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country?: string;
  };

  /** Sender's name (return address) */
  senderName?: string;

  /** Sender's address (return address) */
  senderAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country?: string;
  };

  /** Letter message content */
  message: string;

  /** Optional metadata to pass to provider */
  metadata?: Record<string, any>;

  /** Color printing (true) or black & white (false) */
  color?: boolean;

  /** Double-sided printing */
  doubleSided?: boolean;

  /** Extra services (certified mail, etc.) */
  extraServices?: string[];
}

/**
 * Result of sending a letter
 */
export interface LetterResult {
  /** Whether the letter was successfully queued/sent */
  success: boolean;

  /** Provider-specific tracking/job ID */
  trackingId: string;

  /** Expected delivery date (if available) */
  expectedDeliveryDate?: Date;

  /** Cost in cents */
  costCents?: number;

  /** URL to view letter details (if available) */
  detailsUrl?: string;

  /** Provider-specific metadata */
  metadata?: Record<string, any>;

  /** Error message if failed */
  error?: string;
}

/**
 * Letter delivery status
 */
export interface LetterStatus {
  /** Provider-specific tracking ID */
  trackingId: string;

  /** Current status */
  status: 'queued' | 'processing' | 'in_transit' | 'delivered' | 'failed' | 'returned';

  /** Human-readable status message */
  statusMessage: string;

  /** Timestamp of last update */
  lastUpdated: Date;

  /** Delivery confirmation date (if delivered) */
  deliveredAt?: Date;

  /** Provider-specific tracking events */
  events?: Array<{
    timestamp: Date;
    status: string;
    message: string;
    location?: string;
  }>;

  /** Error details if failed */
  error?: string;
}

/**
 * Cost estimate for a letter
 */
export interface CostEstimate {
  /** Base cost in cents */
  baseCostCents: number;

  /** Postage cost in cents */
  postageCents: number;

  /** Additional services cost in cents */
  servicesCents: number;

  /** Total cost in cents */
  totalCents: number;

  /** Cost breakdown details */
  breakdown?: Array<{
    item: string;
    costCents: number;
  }>;
}

/**
 * Provider capabilities and configuration
 */
export interface ProviderConfig {
  /** Provider name (e.g., "lob", "postgrid", "dummy") */
  name: string;

  /** Display name for UI */
  displayName: string;

  /** Whether provider is enabled */
  enabled: boolean;

  /** API credentials */
  credentials?: {
    apiKey?: string;
    apiSecret?: string;
    [key: string]: any;
  };

  /** Provider-specific configuration */
  config?: Record<string, any>;

  /** Supported features */
  features?: {
    colorPrinting?: boolean;
    doubleSided?: boolean;
    certifiedMail?: boolean;
    internationalMail?: boolean;
    tracking?: boolean;
  };
}

/**
 * Letter Fulfillment Provider Interface
 *
 * All letter fulfillment providers must implement this interface
 */
export interface LetterFulfillmentProvider {
  /** Provider configuration */
  readonly config: ProviderConfig;

  /**
   * Send a letter
   * @param params Letter parameters
   * @returns Result with tracking ID
   * @throws Error if sending fails
   */
  sendLetter(params: LetterParams): Promise<LetterResult>;

  /**
   * Get delivery status of a letter
   * @param trackingId Provider-specific tracking ID
   * @returns Current status
   * @throws Error if tracking ID not found
   */
  getStatus(trackingId: string): Promise<LetterStatus>;

  /**
   * Estimate cost for a letter
   * @param params Letter parameters
   * @returns Cost estimate in cents
   */
  estimateCost(params: LetterParams): Promise<CostEstimate>;

  /**
   * Cancel a queued letter (if supported)
   * @param trackingId Provider-specific tracking ID
   * @returns Whether cancellation was successful
   */
  cancelLetter?(trackingId: string): Promise<boolean>;

  /**
   * Validate provider credentials and connection
   * @returns Whether provider is ready to use
   */
  validateConnection(): Promise<boolean>;

  /**
   * Validate an address (if supported by provider)
   * @param address Address to validate
   * @returns Validation result with corrected address if available
   */
  validateAddress?(address: AddressValidationInput): Promise<AddressValidationResult>;
}

/**
 * Address validation input
 */
export interface AddressValidationInput {
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Address validation result
 */
export interface AddressValidationResult {
  /** Validation status */
  status: 'verified' | 'corrected' | 'failed';

  /** Whether the address is deliverable */
  isValid: boolean;

  /** Original address (as provided) */
  originalAddress: AddressValidationInput;

  /** Corrected/verified address (if status is 'verified' or 'corrected') */
  verifiedAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };

  /** Specific errors or issues found */
  errors?: Array<{
    field: string;
    message: string;
  }>;

  /** Additional details (county, congressional district, etc.) */
  details?: Record<string, any>;

  /** Geographic coordinates (if available) */
  geocode?: {
    latitude: number;
    longitude: number;
  };
}

/**
 * Provider factory function type
 */
export type ProviderFactory = (config: ProviderConfig) => LetterFulfillmentProvider;

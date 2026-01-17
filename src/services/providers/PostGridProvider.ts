/**
 * PostGrid Letter Fulfillment Provider
 *
 * Production-ready provider for sending physical mail via PostGrid's Print & Mail API
 *
 * Features:
 * - Pay-as-you-go pricing (no monthly fees)
 * - Address verification for 245 countries
 * - 2-day production SLA
 * - Real-time tracking
 * - Test/live environment separation
 *
 * Documentation: https://docs.postgrid.com/
 */

import type {
  LetterFulfillmentProvider,
  LetterParams,
  LetterResult,
  LetterStatus,
  CostEstimate,
  ProviderConfig,
  AddressValidationInput,
  AddressValidationResult,
  PostcardParams,
  PostcardResult,
  PostcardSize,
  LetterLayoutType
} from './types.js';

export interface PostGridProviderOptions {
  /** PostGrid API key (test or live) */
  apiKey: string;

  /** API base URL (default: production) */
  baseUrl?: string;

  /** Mode: 'test' or 'live' (default: 'test') */
  mode?: 'test' | 'live';

  /** Whether to log operations (default: true) */
  verbose?: boolean;
}

/**
 * PostGrid API request/response types
 */
interface PostGridContact {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  provinceOrState: string;
  postalOrZip: string;
  country: string;
}

interface PostGridLetterRequest {
  to: PostGridContact;
  from: PostGridContact;
  html: string;
  description?: string;
  color?: boolean;
  doubleSided?: boolean;
  addressPlacement?: 'top_first_page' | 'insert_blank_page';
}

interface PostGridLetterResponse {
  id: string;
  object: 'letter';
  live: boolean;
  status: string;
  sendDate?: string;
  expectedDeliveryDate?: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

interface PostGridError {
  error: {
    message: string;
    code?: string;
    details?: any;
  };
}

interface PostGridPostcardRequest {
  to: PostGridContact;
  from: PostGridContact;
  frontHTML: string;
  backHTML: string;
  size: '6x4' | '6x9' | '6x11';
  description?: string;
}

interface PostGridPostcardResponse {
  id: string;
  object: 'postcard';
  live: boolean;
  status: string;
  sendDate?: string;
  expectedDeliveryDate?: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  trackingNumber?: string;
}

interface PostGridAddressVerificationRequest {
  line1: string;
  line2?: string;
  city?: string;
  provinceOrState?: string;
  postalOrZip?: string;
  country?: string;
}

interface PostGridAddressVerificationResponse {
  status: string;
  message: string;
  data: {
    status: 'verified' | 'corrected' | 'failed';
    line1?: string;
    line2?: string;
    city?: string;
    provinceOrState?: string;
    postalOrZip?: string;
    country?: string;
    errors?: Record<string, string[]>;
    details?: {
      county?: string;
      congressional_district?: string;
      [key: string]: any;
    };
    geocode?: {
      latitude: number;
      longitude: number;
    };
  };
}

export class PostGridProvider implements LetterFulfillmentProvider {
  public readonly config: ProviderConfig;
  private options: Required<PostGridProviderOptions>;

  constructor(config: ProviderConfig, options: PostGridProviderOptions) {
    this.config = config;
    this.options = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? 'https://api.postgrid.com/print-mail/v1',
      mode: options.mode ?? 'test',
      verbose: options.verbose ?? true
    };

    if (this.options.verbose) {
      console.log(`✅ PostGridProvider initialized`);
      console.log(`   Mode: ${this.options.mode}`);
      console.log(`   Base URL: ${this.options.baseUrl}`);
    }
  }

  /**
   * Send a letter via PostGrid API
   */
  async sendLetter(params: LetterParams): Promise<LetterResult> {
    if (this.options.verbose) {
      console.log(`📤 [PostGrid] Sending letter to ${params.recipientName}`);
    }

    try {
      // Build request payload
      const request: PostGridLetterRequest = {
        to: this.buildContact(params.recipientName, params.recipientAddress),
        from: this.buildContact(
          params.senderName || 'Letter IRL',
          params.senderAddress || this.getDefaultSenderAddress()
        ),
        html: this.generateHTML(params.message, {
          layoutType: params.layoutType,
          headerImageData: params.headerImageData,
          inlineImageData: params.inlineImageData,
        }),
        description: `Letter to ${params.recipientName}`,
        // Enable color printing for layouts with images
        color: params.color ?? (params.layoutType !== 'text_only' && (!!params.headerImageData || !!params.inlineImageData)),
        doubleSided: params.doubleSided ?? false,
        addressPlacement: 'top_first_page'
      };

      // Make API request
      const response = await this.apiRequest<PostGridLetterResponse>('POST', '/letters', request);

      if (this.options.verbose) {
        console.log(`✅ [PostGrid] Letter created successfully`);
        console.log(`   Letter ID: ${response.id}`);
        console.log(`   Status: ${response.status}`);
        console.log(`   Expected Delivery: ${response.expectedDeliveryDate || 'Unknown'}`);
      }

      // Parse expected delivery date
      const expectedDeliveryDate = response.expectedDeliveryDate
        ? new Date(response.expectedDeliveryDate)
        : undefined;

      return {
        success: true,
        trackingId: response.id,
        expectedDeliveryDate,
        costCents: this.estimateCostSync(params),
        detailsUrl: response.url,
        metadata: {
          provider: 'postgrid',
          mode: this.options.mode,
          status: response.status,
          trackingNumber: response.trackingNumber,
          trackingUrl: response.trackingUrl
        }
      };
    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);

      if (this.options.verbose) {
        console.log(`❌ [PostGrid] Failed to send letter: ${errorMessage}`);
      }

      return {
        success: false,
        trackingId: '',
        error: errorMessage
      };
    }
  }

  /**
   * Get delivery status of a letter or postcard
   */
  async getStatus(trackingId: string): Promise<LetterStatus> {
    try {
      // Determine endpoint based on tracking ID prefix
      const isPostcard = trackingId.startsWith('postcard_');
      const endpoint = isPostcard ? `/postcards/${trackingId}` : `/letters/${trackingId}`;

      const response = await this.apiRequest<PostGridLetterResponse>('GET', endpoint);

      // Map PostGrid status to our status
      const status = this.mapStatus(response.status);
      const statusMessage = this.getStatusMessage(response.status);

      const letterStatus: LetterStatus = {
        trackingId,
        status,
        statusMessage,
        lastUpdated: new Date(response.updatedAt),
        deliveredAt: status === 'delivered' && response.expectedDeliveryDate
          ? new Date(response.expectedDeliveryDate)
          : undefined,
        events: [] // PostGrid doesn't provide detailed events in basic API
      };

      // Add tracking URL if available
      if (response.trackingUrl) {
        letterStatus.events = [{
          timestamp: new Date(response.createdAt),
          status: response.status,
          message: statusMessage,
          location: undefined
        }];
      }

      return letterStatus;
    } catch (error) {
      throw new Error(`Failed to get status for ${trackingId}: ${this.extractErrorMessage(error)}`);
    }
  }

  /**
   * Estimate cost for a letter
   */
  async estimateCost(params: LetterParams): Promise<CostEstimate> {
    // PostGrid doesn't provide a cost estimation API endpoint
    // We'll use approximate costs based on their pricing
    const totalCents = this.estimateCostSync(params);

    const baseCost = 50; // ~$0.50 for printing/handling
    const postageCost = 73; // ~$0.73 for First-Class postage (2025 USPS rate)
    const colorExtra = params.color ? 35 : 0; // ~$0.35 extra for color
    const doubleSidedExtra = params.doubleSided ? 10 : 0; // ~$0.10 extra for double-sided

    return {
      baseCostCents: baseCost,
      postageCents: postageCost,
      servicesCents: colorExtra + doubleSidedExtra,
      totalCents,
      breakdown: [
        { item: 'Printing & Handling', costCents: baseCost },
        { item: 'First-Class Postage', costCents: postageCost },
        ...(params.color ? [{ item: 'Color Printing', costCents: colorExtra }] : []),
        ...(params.doubleSided ? [{ item: 'Double-Sided', costCents: doubleSidedExtra }] : [])
      ]
    };
  }

  /**
   * Validate provider credentials and connection
   */
  async validateConnection(): Promise<boolean> {
    try {
      // Try to make a simple API call to verify credentials
      // PostGrid doesn't have a dedicated health check endpoint, so we'll use the letters endpoint
      await this.apiRequest<any>('GET', '/letters?limit=1');

      if (this.options.verbose) {
        console.log(`✅ [PostGrid] Connection validated`);
      }

      return true;
    } catch (error) {
      if (this.options.verbose) {
        console.log(`❌ [PostGrid] Connection validation failed: ${this.extractErrorMessage(error)}`);
      }

      return false;
    }
  }

  /**
   * Build PostGrid contact object from name and address
   */
  private buildContact(
    name: string,
    address: LetterParams['recipientAddress']
  ): PostGridContact {
    // Split name into first/last (simple approach)
    const nameParts = name.trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    return {
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      companyName: nameParts.length === 1 ? name : undefined,
      addressLine1: address.line1,
      addressLine2: address.line2,
      city: address.city,
      provinceOrState: address.state,
      postalOrZip: address.postalCode,
      country: address.country || 'US'
    };
  }

  /**
   * Generate HTML content for the letter (US-LAYOUT-06)
   * Supports text_only, header_image, and inline_image layouts
   */
  private generateHTML(
    message: string,
    options?: {
      layoutType?: LetterLayoutType;
      headerImageData?: string;
      inlineImageData?: string;
    }
  ): string {
    const layoutType = options?.layoutType || 'text_only';

    // Escape HTML special characters in message
    const escapedMessage = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    switch (layoutType) {
      case 'header_image':
        return this.generateHeaderImageHTML(escapedMessage, options?.headerImageData);
      case 'inline_image':
        return this.generateInlineImageHTML(escapedMessage, options?.inlineImageData);
      case 'text_only':
      default:
        return this.generateTextOnlyHTML(escapedMessage);
    }
  }

  /**
   * Generate text-only layout HTML
   */
  private generateTextOnlyHTML(escapedMessage: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      /* Larger top margin to avoid address window overlap */
      margin: 3.5in 1in 1in 1in;
      color: #000;
    }
    .letter-body {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
  </style>
</head>
<body>
  <div class="letter-body">${escapedMessage}</div>
</body>
</html>`;
  }

  /**
   * Generate header image layout HTML (US-LAYOUT-01)
   * Header image appears at top of content area, below the address window
   */
  private generateHeaderImageHTML(escapedMessage: string, headerImageData?: string): string {
    const headerHtml = headerImageData
      ? `<div class="header-image"><img src="${headerImageData}" alt="Header"></div>`
      : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      /* Larger top margin to avoid address window overlap */
      margin: 3.5in 1in 1in 1in;
      color: #000;
    }
    .header-image {
      width: 100%;
      max-height: 2in;
      margin-bottom: 0.5in;
      text-align: center;
    }
    .header-image img {
      max-width: 100%;
      max-height: 2in;
      object-fit: contain;
    }
    .letter-body {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
  </style>
</head>
<body>
  ${headerHtml}
  <div class="letter-body">${escapedMessage}</div>
</body>
</html>`;
  }

  /**
   * Generate inline image layout HTML (US-LAYOUT-02)
   * Inline image appears after the message/signature
   */
  private generateInlineImageHTML(escapedMessage: string, inlineImageData?: string): string {
    const inlineHtml = inlineImageData
      ? `<div class="inline-image"><img src="${inlineImageData}" alt="Photo"></div>`
      : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Times New Roman', serif;
      font-size: 12pt;
      line-height: 1.6;
      /* Larger top margin to avoid address window overlap */
      margin: 3.5in 1in 1in 1in;
      color: #000;
    }
    .letter-body {
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .inline-image {
      width: 100%;
      max-height: 3in;
      margin-top: 0.5in;
      text-align: center;
    }
    .inline-image img {
      max-width: 100%;
      max-height: 3in;
      object-fit: contain;
    }
  </style>
</head>
<body>
  <div class="letter-body">${escapedMessage}</div>
  ${inlineHtml}
</body>
</html>`;
  }

  /**
   * Make API request to PostGrid
   */
  private async apiRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    body?: any
  ): Promise<T> {
    const url = `${this.options.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'x-api-key': this.options.apiKey,
      'Content-Type': 'application/json'
    };

    const requestOptions: RequestInit = {
      method,
      headers,
      ...(body && { body: JSON.stringify(body) })
    };

    if (this.options.verbose) {
      console.log(`🌐 [PostGrid] ${method} ${endpoint}`);
    }

    const response = await fetch(url, requestOptions);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } })) as PostGridError;
      throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
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
    if (error?.error?.message) {
      return error.error.message;
    }
    return 'Unknown error occurred';
  }

  /**
   * Map PostGrid status to our standard status
   *
   * PostGrid lifecycle: ready → rendered → processed → printed → mailed → in_transit → delivered
   * Our lifecycle: accepted → printing → in_transit → delivered
   */
  private mapStatus(postgridStatus: string): LetterStatus['status'] {
    const statusMap: Record<string, LetterStatus['status']> = {
      // PostGrid accepted the order (awaiting print)
      'ready': 'accepted',
      'rendered': 'accepted',
      // At printer / being printed
      'processed': 'processing',
      'printed': 'processing',
      // Handed to USPS / in postal system
      'mailed': 'in_transit',
      'in_transit': 'in_transit',
      'processed_for_delivery': 'in_transit',  // PostGrid test mode status
      // Terminal statuses
      'delivered': 'delivered',
      'completed': 'delivered',  // PostGrid test mode uses "completed" instead of "delivered"
      'returned': 'returned',
      'canceled': 'failed'
    };

    return statusMap[postgridStatus.toLowerCase()] || 'accepted';
  }

  /**
   * Get human-readable status message
   */
  private getStatusMessage(postgridStatus: string): string {
    const messageMap: Record<string, string> = {
      'ready': 'Letter is queued for processing',
      'rendered': 'Letter PDF has been generated',
      'processed': 'Letter has been sent to printer',
      'printed': 'Letter has been printed',
      'mailed': 'Letter has been handed to postal service',
      'in_transit': 'Letter is in transit to recipient',
      'processed_for_delivery': 'Letter is in transit to recipient',  // PostGrid test mode
      'delivered': 'Letter has been delivered',
      'completed': 'Letter has been delivered',  // PostGrid test mode
      'returned': 'Letter was returned to sender',
      'canceled': 'Letter was canceled before sending'
    };

    return messageMap[postgridStatus.toLowerCase()] || `Status: ${postgridStatus}`;
  }

  /**
   * Estimate cost synchronously (for immediate response)
   */
  private estimateCostSync(params: LetterParams): number {
    let baseCost = 85; // Base cost: ~$0.85 (black & white, single-sided)

    if (params.color) {
      baseCost = 120; // Color printing: ~$1.20
    }

    if (params.doubleSided) {
      baseCost += 10; // Double-sided: +$0.10
    }

    return baseCost;
  }

  /**
   * Validate an address using PostGrid's Address Verification API
   */
  async validateAddress(address: AddressValidationInput): Promise<AddressValidationResult> {
    if (this.options.verbose) {
      console.log(`🔍 [PostGrid] Validating address: ${address.line1}, ${address.city}, ${address.state}`);
    }

    try {
      // Determine if this is an international address (non-US/Canada)
      const isInternational = address.country &&
        address.country !== 'US' &&
        address.country !== 'USA' &&
        address.country !== 'CA' &&
        address.country !== 'CAN';

      // Choose the appropriate API endpoint
      const baseUrl = isInternational
        ? 'https://api.postgrid.com/v1/intl_addver'
        : 'https://api.postgrid.com/v1/addver';

      // Build request payload
      const addressPayload: PostGridAddressVerificationRequest = {
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        provinceOrState: address.state,
        postalOrZip: address.postalCode,
        country: address.country || 'US'
      };

      // PostGrid expects the address wrapped in an "address" field
      const request = {
        address: addressPayload
      };

      // Make API request with query params for enhanced data
      const response = await this.apiRequestAddressVerification<PostGridAddressVerificationResponse>(
        'POST',
        `${baseUrl}/verifications?includeDetails=true&properCase=true&geocode=true`,
        request
      );

      // Extract the actual address data from the response
      const addressData = response.data;

      if (this.options.verbose) {
        console.log(`✅ [PostGrid] Address validation status: ${addressData.status}`);
      }

      // Build result
      const result: AddressValidationResult = {
        status: addressData.status,
        isValid: addressData.status === 'verified' || addressData.status === 'corrected',
        originalAddress: address
      };

      // Add verified/corrected address if available
      if (result.isValid && addressData.line1) {
        result.verifiedAddress = {
          line1: addressData.line1,
          line2: addressData.line2,
          city: addressData.city || address.city || '',
          state: addressData.provinceOrState || address.state || '',
          postalCode: addressData.postalOrZip || address.postalCode || '',
          country: addressData.country || address.country || 'US'
        };
      }

      // Add errors if present
      if (addressData.errors) {
        result.errors = Object.entries(addressData.errors).flatMap(([field, messages]) =>
          messages.map(message => ({ field, message }))
        );
      }

      // Add details if present
      if (addressData.details) {
        result.details = addressData.details;
      }

      // Add geocoding if present
      if (addressData.geocode) {
        result.geocode = addressData.geocode;
      }

      return result;
    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);

      if (this.options.verbose) {
        console.log(`❌ [PostGrid] Address validation failed: ${errorMessage}`);
      }

      // Return failed validation result
      return {
        status: 'failed',
        isValid: false,
        originalAddress: address,
        errors: [{
          field: 'address',
          message: errorMessage
        }]
      };
    }
  }

  /**
   * Make API request to PostGrid Address Verification endpoint
   * (separate from main API request to handle different base URL)
   */
  private async apiRequestAddressVerification<T>(
    method: 'POST',
    url: string,
    body?: any
  ): Promise<T> {
    // Use separate Address Verification API key if available, otherwise fall back to Print & Mail key
    const apiKey = process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY || this.options.apiKey;

    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'Content-Type': 'application/json'
    };

    const requestOptions: RequestInit = {
      method,
      headers,
      ...(body && { body: JSON.stringify(body) })
    };

    if (this.options.verbose) {
      console.log(`🌐 [PostGrid] ${method} ${url.split('?')[0]}`);
    }

    const response = await fetch(url, requestOptions);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } })) as PostGridError;
      throw new Error(errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get default sender address (fallback)
   */
  private getDefaultSenderAddress(): LetterParams['recipientAddress'] {
    return {
      line1: process.env.LETTER_IRL_DEFAULT_SENDER_ADDRESS || '123 Main St',
      city: process.env.LETTER_IRL_DEFAULT_SENDER_CITY || 'San Francisco',
      state: process.env.LETTER_IRL_DEFAULT_SENDER_STATE || 'CA',
      postalCode: process.env.LETTER_IRL_DEFAULT_SENDER_ZIP || '94102',
      country: 'US'
    };
  }

  // ==========================================================================
  // Postcard Methods (US-POSTCARD-01, US-POSTCARD-02)
  // ==========================================================================

  /**
   * Send a postcard via PostGrid API
   */
  async sendPostcard(params: PostcardParams): Promise<PostcardResult> {
    if (this.options.verbose) {
      console.log(`📤 [PostGrid] Sending postcard to ${params.recipientName}`);
    }

    try {
      const size = params.size || '6x9';

      // PostGrid uses width x height format (e.g., '9x6' for a 6x9 postcard)
      // Our internal format is height x width, so we need to map them
      const postGridSizeMap: Record<PostcardSize, string> = {
        '6x4': '6x4',   // 4" tall x 6" wide - same format
        '6x9': '9x6',   // 9" tall x 6" wide -> PostGrid wants 9x6
        '6x11': '11x6'  // 11" tall x 6" wide -> PostGrid wants 11x6
      };
      const postGridSize = postGridSizeMap[size];

      // Build request payload
      const request: PostGridPostcardRequest = {
        to: this.buildContact(params.recipientName, params.recipientAddress),
        from: this.buildContact(
          params.senderName || 'Letter IRL',
          params.senderAddress || this.getDefaultSenderAddress()
        ),
        frontHTML: this.generatePostcardFrontHTML(params.frontImageBase64, size),
        backHTML: this.generatePostcardBackHTML(
          params.backMessage,
          params.senderName,
          params.senderAddress
        ),
        size: postGridSize,
        description: `Postcard to ${params.recipientName}`
      };

      // Make API request
      const response = await this.apiRequest<PostGridPostcardResponse>('POST', '/postcards', request);

      if (this.options.verbose) {
        console.log(`✅ [PostGrid] Postcard created successfully`);
        console.log(`   Postcard ID: ${response.id}`);
        console.log(`   Status: ${response.status}`);
        console.log(`   Expected Delivery: ${response.expectedDeliveryDate || 'Unknown'}`);
      }

      // Parse expected delivery date
      const expectedDeliveryDate = response.expectedDeliveryDate
        ? new Date(response.expectedDeliveryDate)
        : undefined;

      return {
        success: true,
        trackingId: response.id,
        expectedDeliveryDate,
        costCents: this.estimatePostcardCost(size),
        detailsUrl: response.url,
        metadata: {
          provider: 'postgrid',
          mode: this.options.mode,
          status: response.status,
          trackingNumber: response.trackingNumber,
          size
        }
      };
    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);

      if (this.options.verbose) {
        console.log(`❌ [PostGrid] Failed to send postcard: ${errorMessage}`);
      }

      return {
        success: false,
        trackingId: '',
        error: errorMessage
      };
    }
  }

  /**
   * Generate HTML for postcard front (full-bleed image)
   */
  private generatePostcardFrontHTML(imageBase64: string, size: PostcardSize): string {
    // PostGrid uses landscape orientation (width x height)
    // PostGrid 6x4 = 6" wide x 4" tall
    // PostGrid 9x6 = 9" wide x 6" tall (we call it '6x9' internally)
    // PostGrid 11x6 = 11" wide x 6" tall (we call it '6x11' internally)
    const dimensions: Record<PostcardSize, { width: string; height: string }> = {
      '6x4': { width: '6in', height: '4in' },
      '6x9': { width: '9in', height: '6in' },
      '6x11': { width: '11in', height: '6in' }
    };

    const dim = dimensions[size];

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: ${dim.width};
      height: ${dim.height};
    }
    .postcard-front {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .postcard-front img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
    }
  </style>
</head>
<body>
  <div class="postcard-front">
    <img src="${imageBase64}" alt="Postcard image" />
  </div>
</body>
</html>`;
  }

  /**
   * Generate HTML for postcard back (message only)
   * Note: PostGrid automatically handles return address, recipient address,
   * and postage from the 'from' and 'to' fields in the API request
   */
  private generatePostcardBackHTML(
    message: string,
    _senderName?: string,
    _senderAddress?: PostcardParams['senderAddress']
  ): string {
    // Escape HTML special characters in message
    const escapedMessage = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    // PostGrid handles addresses automatically - we only provide the message
    // The message area is on the left half of a standard postcard back
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 9in;
      height: 6in;
      background: #fffef8;
    }
    .postcard-back {
      display: flex;
      height: 100%;
    }
    .message-area {
      width: 50%;
      padding: 0.4in;
      box-sizing: border-box;
      display: flex;
      align-items: flex-start;
    }
    .message {
      font-family: 'Georgia', serif;
      font-size: 14pt;
      line-height: 1.6;
      color: #333;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
  </style>
</head>
<body>
  <div class="postcard-back">
    <div class="message-area">
      <div class="message">${escapedMessage}</div>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Estimate cost for a postcard
   */
  private estimatePostcardCost(size: PostcardSize): number {
    // PostGrid postcard pricing (approximate)
    const costs: Record<PostcardSize, number> = {
      '6x4': 79,  // ~$0.79
      '6x9': 98,  // ~$0.98
      '6x11': 115 // ~$1.15
    };

    return costs[size] || costs['6x9'];
  }
}

/**
 * Shared TypeScript types for Letter IRL services
 */

// ============================================================================
// User Types
// ============================================================================

// User tiers for rate limit differentiation
export const USER_TIERS = ['standard', 'trusted'] as const;
export type UserTier = typeof USER_TIERS[number];

export interface User {
  user_id: string;
  email: string;
  credits: number;
  credits_purchased: number;
  credits_used: number;
  image_generations_used: number;
  tier: UserTier;
  tier_override: UserTier | null;
  tier_calculated_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserParams {
  userId: string;
  email: string;
}

// ============================================================================
// Credit Transaction Types
// ============================================================================

export type TransactionType = 'purchase' | 'deduction' | 'refund' | 'adjustment';
export type ReferenceType = 'order' | 'letter' | 'manual';

export interface CreditTransaction {
  transaction_id: number;
  user_id: string;
  amount: number;
  balance_after: number;
  type: TransactionType;
  reference_type?: ReferenceType;
  reference_id?: string;
  description?: string;
  created_at: Date;
}

export interface AddCreditsParams {
  userId: string;
  email: string;
  credits: number;
  orderId: string;
  description?: string;
}

export interface DeductCreditsParams {
  userId: string;
  credits: number;
  letterId: string;
  description?: string;
}

export interface RefundCreditsParams {
  userId: string;
  credits: number;
  orderId: string;
  reason?: string;
}

export interface GetTransactionsParams {
  userId: string;
  limit?: number;
  offset?: number;
  type?: TransactionType;
}

export interface CreditBalance {
  credits: number;
  credits_purchased: number;
  credits_used: number;
}

export interface CreditOperationResult {
  user: User;
  transaction: CreditTransaction;
}

export interface TransactionHistoryResult {
  transactions: CreditTransaction[];
  total: number;
}

// ============================================================================
// Order Types
// ============================================================================

export type CommerceOrderType = 'letter_pack' | 'jit_mail';

export type OrderStatus =
  | 'checkout_pending'
  | 'paid'
  | 'fulfillment_pending'
  | 'fulfilled'
  | 'payment_failed'
  | 'refund_pending'
  | 'refunded'
  | 'cancelled';

export interface Order {
  order_id: string;
  user_id: string;
  order_type: CommerceOrderType;
  draft_id?: string;
  letter_id?: string;
  product_code: string;
  product_snapshot: Record<string, unknown>;
  credits?: number;
  amount_cents: number;
  currency: string;
  payment_provider: string;
  stripe_checkout_session_id?: string;
  stripe_payment_intent_id?: string;
  stripe_refund_id?: string;
  idempotency_key: string;
  checkout_url?: string;
  checkout_expires_at?: Date;
  status: OrderStatus;
  paid_at?: Date;
  fulfillment_started_at?: Date;
  fulfilled_at?: Date;
  payment_failed_at?: Date;
  refund_pending_at?: Date;
  refunded_at?: Date;
  refund_attempts: number;
  last_error_code?: string;
  last_error?: string;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date;
}

// ============================================================================
// Letter Types
// ============================================================================

export type LetterStatus = 'draft' | 'queued' | 'processing' | 'sent' | 'failed' | 'cancelled';

export interface Letter {
  letter_id: string;
  user_id: string;
  content: any; // JSON
  recipient: any; // JSON
  credits_cost: number;
  status: LetterStatus;
  mail_type: MailType;
  funding_type: 'prepaid_balance' | 'jit_order';
  funding_order_id?: string;
  preview_html?: string;
  tracking_id?: string;
  created_at: Date;
  sent_at?: Date;
}

// ============================================================================
// Image Entitlement Types
// ============================================================================

export type ImageEntitlementStatus = 'active' | 'depleted' | 'expired' | 'revoked';

export interface ImageEntitlement {
  entitlement_id: string;
  user_id: string;
  source_type: string;
  source_reference_id: string;
  source_order_id?: string;
  quantity: number;
  consumed_quantity: number;
  status: ImageEntitlementStatus;
  expires_at?: Date;
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Letter Job Types
// ============================================================================

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface LetterJob {
  job_id: string;
  letter_id: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  scheduled_at: Date;
  idempotency_key: string;
  next_attempt_at: Date;
  locked_at?: Date;
  provider_order_id?: string;
  last_error?: string;
  started_at?: Date;
  completed_at?: Date;
  error_message?: string;
  metadata?: any; // JSON
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Auth Types
// ============================================================================

export interface AuthenticatedUser {
  userId: string;
  email?: string;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiError {
  error: string;
  message?: string;
  details?: any;
}

export interface BalanceResponse {
  userId: string;
  credits: number;
  credits_purchased: number;
  credits_used: number;
}

export interface TransactionsResponse {
  transactions: CreditTransaction[];
  total: number;
  limit: number;
  offset: number;
}

export interface UserResponse {
  userId: string;
  email: string;
  credits: number;
  creditsPurchased: number;
  creditsUsed: number;
  createdAt: Date;
}

// ============================================================================
// Credit Ledger Types
// ============================================================================

export type CreditSourceType =
  | 'purchase'       // Stripe/payment purchases
  | 'signup_bonus'   // New user welcome credits
  | 'promo'          // Promotional campaign credits
  | 'adjustment'     // Manual admin adjustments
  | 'refund'         // Refunds from cancelled orders/letters
  | 'legacy';        // Migrated from old system

export type CreditLedgerStatus = 'active' | 'depleted' | 'expired' | 'revoked';

export type ExpirationPolicy = 'fixed_date' | 'days_from_activation' | 'never';

export interface CreditLedgerEntry {
  ledger_id: string;
  user_id: string;
  initial_amount: number;
  remaining_amount: number;
  source_type: CreditSourceType;
  source_reference_id?: string;
  source_metadata?: Record<string, unknown>;
  activated_at: Date;
  expires_at?: Date;
  expiration_policy?: ExpirationPolicy;
  expiration_days?: number;
  status: CreditLedgerStatus;
  description?: string;
  related_ledger_id?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreditConsumption {
  consumption_id: string;
  transaction_id: number;
  ledger_id: string;
  amount: number;
  ledger_remaining_after: number;
  created_at: Date;
}

// ============================================================================
// Credit Ledger Operation Parameters
// ============================================================================

export interface AddCreditsToLedgerParams {
  userId: string;
  email?: string;  // For user creation if needed
  credits: number;
  sourceType: CreditSourceType;
  sourceReferenceId?: string;
  sourceMetadata?: Record<string, unknown>;
  expirationPolicy?: ExpirationPolicy;
  expiresAt?: Date;           // For fixed_date policy
  expirationDays?: number;    // For days_from_activation policy
  description?: string;
}

export interface DeductCreditsFromLedgerParams {
  userId: string;
  credits: number;
  letterId: string;
  description?: string;
}

export interface RefundCreditsToLedgerParams {
  userId: string;
  originalLedgerId?: string;  // Optional: link to original entry
  credits: number;
  orderId?: string;
  reason?: string;
  inheritExpiration?: boolean;  // Use same expiration as original
  newExpirationDays?: number;   // Or set new expiration
}

export interface GetLedgerEntriesParams {
  userId: string;
  status?: CreditLedgerStatus[];
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Credit Balance Types (Enhanced)
// ============================================================================

export interface ExpiringBucket {
  expiresAt: Date | null;  // null = never expires
  credits: number;
  ledgerIds: string[];
}

export interface SourceBreakdown {
  sourceType: CreditSourceType;
  available: number;
  total: number;
}

export interface CreditBalanceDetailed {
  totalAvailable: number;           // Sum of active, non-expired remaining
  expiringSoon: number;             // Expiring in next 30 days
  expiringDates: ExpiringBucket[];  // Breakdown by expiration
  neverExpiring: number;            // Credits that never expire
  bySource: SourceBreakdown[];      // Breakdown by source type
}

export interface CreditLedgerOperationResult {
  user: User;
  transaction: CreditTransaction;
  ledgerEntry?: CreditLedgerEntry;
  consumedFrom?: CreditConsumption[];
}

export interface LedgerEntriesResult {
  entries: CreditLedgerEntry[];
  total: number;
}

// ============================================================================
// Promo Campaign Types
// ============================================================================

export type PromoCampaignStatus = 'draft' | 'active' | 'paused' | 'ended' | 'expired';

export interface PromoCampaign {
  campaign_id: string;
  code: string;
  name: string;
  description?: string;
  credits_amount: number;
  expiration_policy: ExpirationPolicy;
  expiration_days?: number;
  fixed_expiration_date?: Date;
  max_total_redemptions?: number;
  max_per_user: number;
  current_redemptions: number;
  starts_at: Date;
  ends_at?: Date;
  requires_new_user: boolean;
  status: PromoCampaignStatus;
  created_by?: string;
  created_at: Date;
  updated_at: Date;
}

export interface PromoRedemption {
  redemption_id: string;
  campaign_id: string;
  user_id: string;
  ledger_id: string;
  redeemed_at: Date;
}

export interface CreatePromoCampaignParams {
  code: string;
  name: string;
  description?: string;
  creditsAmount: number;
  expirationPolicy?: ExpirationPolicy;
  expirationDays?: number;
  fixedExpirationDate?: Date;
  maxTotalRedemptions?: number;
  maxPerUser?: number;
  startsAt?: Date;
  endsAt?: Date;
  requiresNewUser?: boolean;
  createdBy?: string;
}

export interface RedeemPromoParams {
  userId: string;
  email?: string;
  promoCode: string;
}

export interface RedeemPromoResult {
  success: boolean;
  credits?: number;
  expiresAt?: Date;
  ledgerId?: string;
  error?: string;
}

export interface ValidatePromoResult {
  valid: boolean;
  reason?: string;
  campaign?: PromoCampaign;
}

export interface ListPromoCampaignsParams {
  status?: PromoCampaignStatus[];
  limit?: number;
  offset?: number;
}

export interface PromoCampaignsResult {
  campaigns: PromoCampaign[];
  total: number;
}

// ============================================================================
// Letter Draft Types (for idempotent send operations)
// ============================================================================

export type DraftStatus = 'pending' | 'consumed' | 'expired' | 'cancelled';

export interface LetterDraft {
  draft_id: string;
  user_id: string;
  mail_type?: MailType;
  sender: Record<string, unknown>;       // Address JSON
  recipient: Record<string, unknown>;    // Address JSON
  body_text: string;
  sign_off: string;
  required_credits: number;
  preview_html?: string;
  sender_validation?: Record<string, unknown>;
  recipient_validation?: Record<string, unknown>;
  // Layout fields (US-LAYOUT-01 through US-LAYOUT-06)
  layout_type: LetterLayoutType;
  header_image_data?: string;            // Base64 data URI for header image
  header_image_url?: string;             // Original URL for debugging
  inline_image_data?: string;            // Base64 data URI for inline image
  inline_image_url?: string;             // Original URL for debugging
  status: DraftStatus;
  expires_at: Date;
  consumed_at?: Date;
  consumed_letter_id?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateDraftParams {
  userId: string;
  sender: Record<string, unknown>;
  recipient: Record<string, unknown>;
  bodyText: string;
  signOff: string;
  requiredCredits: number;
  previewHtml?: string;
  senderValidation?: Record<string, unknown>;
  recipientValidation?: Record<string, unknown>;
  expiresInHours?: number;  // Default: 24
  // Layout fields (US-LAYOUT-01 through US-LAYOUT-06)
  layoutType?: LetterLayoutType;          // Default: 'text_only'
  headerImageData?: string;               // Base64 data URI for header image
  headerImageUrl?: string;                // Original URL for debugging
  inlineImageData?: string;               // Base64 data URI for inline image
  inlineImageUrl?: string;                // Original URL for debugging
}

export interface CreateDraftResult {
  draftId: string;
  expiresAt: Date;
}

export interface ConsumeDraftParams {
  draftId: string;
  userId: string;
}

export interface ConsumeDraftResult {
  draft: LetterDraft;
  alreadyConsumed: boolean;
  existingLetterId?: string;  // Set if alreadyConsumed is true
}

export interface DraftNotFoundError extends Error {
  code: 'DRAFT_NOT_FOUND';
  draftId: string;
}

export interface DraftExpiredError extends Error {
  code: 'DRAFT_EXPIRED';
  draftId: string;
  expiredAt: Date;
}

export interface DraftNotOwnedError extends Error {
  code: 'DRAFT_NOT_OWNED';
  draftId: string;
  userId: string;
}

// ============================================================================
// User Tier Types
// ============================================================================

/**
 * Criteria for automatic tier promotion
 */
export interface TierPromotionCriteria {
  minNonRefundedPurchases: number;
  minDaysSinceQualifyingPurchase: number; // Chargeback window protection
}

/**
 * Tier calculation result with diagnostic info
 */
export interface TierCalculationResult {
  tier: UserTier;
  purchaseCount: number;
  daysSinceQualifyingPurchase: number | null; // null if < required purchases
  meetsPurchaseCriteria: boolean;
  meetsAgeCriteria: boolean;
}

/**
 * Result from batch tier update operation
 */
export interface TierUpdateBatchResult {
  checked: number;
  upgraded: number;
  downgraded: number;
  unchanged: number;
  skippedOverride: number;
  details: Array<{
    userId: string;
    oldTier: UserTier;
    newTier: UserTier;
  }>;
}

// ============================================================================
// Personal Access Token Types (US-MCP-01, US-MCP-02, US-MCP-03)
// ============================================================================

export type PATStatus = 'active' | 'revoked';

/**
 * Database row representation of a Personal Access Token
 */
export interface PersonalAccessToken {
  token_id: number;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  status: PATStatus;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

/**
 * Result returned when creating a new token
 * Note: `token` is the raw token shown ONCE to the user
 */
export interface CreateTokenResult {
  token: string;           // Raw token - only shown once!
  tokenId: number;
  name: string;
  expiresAt: Date | null;
}

/**
 * Token info for listing (without sensitive data)
 */
export interface TokenInfo {
  tokenId: number;
  name: string;
  tokenPrefix: string;     // Last 4 chars for display (e.g., "o345")
  status: PATStatus;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/**
 * Result of token validation
 */
export interface ValidateTokenResult {
  valid: boolean;
  userId?: string;
  tokenId?: number;
  error?: string;
}

/**
 * Parameters for creating a token
 */
export interface CreateTokenParams {
  userId: string;
  name: string;
  expiresAt?: Date;
}

/**
 * Result of token revocation
 */
export interface RevokeTokenResult {
  success: boolean;
  alreadyRevoked?: boolean;
}

// ============================================================================
// Mail Type (Letters vs Postcards)
// ============================================================================

export type MailType = 'letter' | 'postcard';

export type PostcardSize = '6x4' | '6x9' | '6x11';

// ============================================================================
// Letter Layout Types (US-LAYOUT-01 through US-LAYOUT-06)
// ============================================================================

export type LetterLayoutType = 'text_only' | 'header_image' | 'inline_image';

export type LetterImageType = 'header' | 'inline';

// ============================================================================
// Image Processing Types (US-POSTCARD-03)
// ============================================================================

export interface ImageFileParam {
  download_url: string;
  file_id: string;
}

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
}

export interface ProcessedImage {
  base64DataUri: string;      // data:image/jpeg;base64,...
  originalWidth: number;
  originalHeight: number;
  processedWidth: number;
  processedHeight: number;
}

export interface ImageProcessingError extends Error {
  code: 'IMAGE_TOO_LARGE' | 'UNSUPPORTED_FORMAT' | 'IMAGE_TOO_SMALL' | 'DOWNLOAD_FAILED' | 'PROCESSING_FAILED';
  userMessage: string;
}

// ============================================================================
// Postcard Draft Types (US-POSTCARD-01, US-POSTCARD-02)
// ============================================================================

export interface PostcardDraft {
  draft_id: string;
  user_id: string;
  mail_type: 'postcard';
  sender: Record<string, unknown>;
  recipient: Record<string, unknown>;
  body_text: string;              // Message for postcards
  sign_off: string | null;        // Optional for postcards
  front_image_data: string;       // Base64 data URI
  front_image_url: string;        // Original URL for debugging
  postcard_size: PostcardSize;
  required_credits: number;
  preview_html?: string;
  sender_validation?: Record<string, unknown>;
  recipient_validation?: Record<string, unknown>;
  status: DraftStatus;
  expires_at: Date;
  consumed_at?: Date;
  consumed_letter_id?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePostcardDraftParams {
  userId: string;
  sender: Record<string, unknown>;
  recipient: Record<string, unknown>;
  message: string;
  frontImageData: string;
  frontImageUrl: string;
  postcardSize?: PostcardSize;    // Default: '6x9'
  requiredCredits?: number;       // Default: 2
  previewHtml?: string;
  senderValidation?: Record<string, unknown>;
  recipientValidation?: Record<string, unknown>;
  expiresInHours?: number;        // Default: 24
}

export interface CreatePostcardDraftResult {
  draftId: string;
  expiresAt: Date;
}

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

export type OrderStatus = 'pending' | 'completed' | 'failed' | 'refunded';

export interface Order {
  order_id: string;
  user_id: string;
  credits: number;
  amount_cents: number;
  currency: string;
  stripe_payment_intent_id?: string;
  status: OrderStatus;
  created_at: Date;
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
  preview_html?: string;
  tracking_id?: string;
  created_at: Date;
  sent_at?: Date;
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
  started_at?: Date;
  completed_at?: Date;
  error_message?: string;
  metadata?: any; // JSON
  created_at: Date;
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
  sender: Record<string, unknown>;       // Address JSON
  recipient: Record<string, unknown>;    // Address JSON
  body_text: string;
  sign_off: string;
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

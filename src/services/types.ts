/**
 * Shared TypeScript types for Letter IRL services
 */

// ============================================================================
// User Types
// ============================================================================

export interface User {
  user_id: string;
  email: string;
  credits: number;
  credits_purchased: number;
  credits_used: number;
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

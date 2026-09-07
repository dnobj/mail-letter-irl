import type { AdminSqlClient } from "../database.js";

/**
 * Account read models. Every SELECT names its columns: the reader role has no
 * access to return addresses, letter content or recipients, so a `*` would
 * fail, and the page must never see them anyway. Email is masked here; the
 * audited reveal is a separate, deliberate query.
 */

export interface AccountSummary {
  userId: string;
  emailMasked: string;
  credits: number;
  creditsPurchased: number;
  creditsUsed: number;
  ledgerAvailable: number;
  cacheMismatch: boolean;
  tier: string;
  tierOverride: string | null;
  tierCalculatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sendsBlockedAt: Date | null;
  sendsBlockedReason: string | null;
  returnAddressValidatedAt: Date | null;
  imageGenerationsUsed: number;
}

export interface LedgerLotView {
  ledgerId: string;
  initialAmount: number;
  remainingAmount: number;
  sourceType: string;
  sourceReferenceId: string | null;
  sourceOrderId: string | null;
  sourceReason: string | null;
  status: string;
  activatedAt: Date;
  expiresAt: Date | null;
  expirationPolicy: string | null;
  description: string | null;
  relatedLedgerId: string | null;
  createdAt: Date;
  /** Active, unexpired and holding credits: the lots consumption would touch. */
  spendable: boolean;
}

export interface AccountOrderView {
  orderId: string;
  orderType: string;
  productCode: string;
  status: string;
  credits: number | null;
  creditsRefunded: number;
  amountCents: number;
  amountRefundedCents: number;
  currency: string;
  stripePaymentIntentId: string | null;
  stripeCheckoutSessionId: string | null;
  letterId: string | null;
  holdReason: string | null;
  stripeDisputeStatus: string | null;
  lastErrorCode: string | null;
  refundAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  refundedAt: Date | null;
}

export interface AccountLetterView {
  letterId: string;
  status: string;
  mailType: string;
  fundingType: string;
  fundingOrderId: string | null;
  creditsCost: number;
  provider: string | null;
  hasTrackingId: boolean;
  createdAt: Date;
  sentAt: Date | null;
  statusUpdatedAt: Date | null;
  redactedAt: Date | null;
  jobId: string | null;
  jobStatus: string | null;
  jobProviderOutcome: string | null;
  jobHoldReason: string | null;
}

export interface ImageQuotaView {
  allowance: number;
  used: number;
  remaining: number;
  activeEntitlements: number;
}

export interface RedemptionView {
  campaignCode: string;
  campaignName: string;
  redeemedAt: Date;
  ledgerId: string;
}

export interface TokenView {
  tokenId: number;
  name: string;
  tokenPrefix: string;
  status: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface TransactionView {
  transactionId: number;
  amount: number;
  balanceAfter: number;
  type: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdAt: Date;
}

export interface AccountDetail {
  account: AccountSummary;
  lots: LedgerLotView[];
  orders: AccountOrderView[];
  letters: AccountLetterView[];
  imageQuota: ImageQuotaView;
  redemptions: RedemptionView[];
  tokens: TokenView[];
  transactions: TransactionView[];
  openDisputes: number;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "(none)";
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.length > 2 ? local.slice(0, 1) : "";
  return `${visible}***@${domain}`;
}

const ACCOUNT_COLUMNS = `
  user_id, email, credits, credits_purchased, credits_used, tier, tier_override,
  tier_calculated_at, created_at, updated_at, sends_blocked_at, sends_blocked_reason,
  return_address_validated_at, image_generations_used
`;

interface AccountRow {
  user_id: string;
  email: string;
  credits: number;
  credits_purchased: number;
  credits_used: number;
  tier: string;
  tier_override: string | null;
  tier_calculated_at: Date | null;
  created_at: Date;
  updated_at: Date;
  sends_blocked_at: Date | null;
  sends_blocked_reason: string | null;
  return_address_validated_at: Date | null;
  image_generations_used: number;
}

function toAccountSummary(row: AccountRow, ledgerAvailable: number): AccountSummary {
  return {
    userId: row.user_id,
    emailMasked: maskEmail(row.email),
    credits: row.credits,
    creditsPurchased: row.credits_purchased,
    creditsUsed: row.credits_used,
    ledgerAvailable,
    cacheMismatch: ledgerAvailable !== row.credits,
    tier: row.tier,
    tierOverride: row.tier_override,
    tierCalculatedAt: row.tier_calculated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sendsBlockedAt: row.sends_blocked_at,
    sendsBlockedReason: row.sends_blocked_reason,
    returnAddressValidatedAt: row.return_address_validated_at,
    imageGenerationsUsed: row.image_generations_used,
  };
}

export const LOT_COLUMNS = `
  ledger_id, initial_amount, remaining_amount, source_type::text AS source_type,
  source_reference_id, source_order_id, source_metadata->>'reason' AS source_reason,
  status::text AS status, activated_at, expires_at, expiration_policy, description,
  related_ledger_id, created_at,
  (status = 'active' AND remaining_amount > 0 AND (expires_at IS NULL OR expires_at > NOW())) AS spendable
`;

export interface LotRow {
  ledger_id: string;
  initial_amount: number;
  remaining_amount: number;
  source_type: string;
  source_reference_id: string | null;
  source_order_id: string | null;
  source_reason: string | null;
  status: string;
  activated_at: Date;
  expires_at: Date | null;
  expiration_policy: string | null;
  description: string | null;
  related_ledger_id: string | null;
  created_at: Date;
  spendable: boolean;
}

export function toLotView(row: LotRow): LedgerLotView {
  return {
    ledgerId: row.ledger_id,
    initialAmount: row.initial_amount,
    remainingAmount: row.remaining_amount,
    sourceType: row.source_type,
    sourceReferenceId: row.source_reference_id,
    sourceOrderId: row.source_order_id,
    sourceReason: row.source_reason,
    status: row.status,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    expirationPolicy: row.expiration_policy,
    description: row.description,
    relatedLedgerId: row.related_ledger_id,
    createdAt: row.created_at,
    spendable: row.spendable,
  };
}

const ORDER_COLUMN_NAMES = [
  "order_id", "order_type", "product_code", "status", "credits", "credits_refunded", "amount_cents",
  "amount_refunded_cents", "currency", "stripe_payment_intent_id", "stripe_checkout_session_id",
  "letter_id", "hold_reason", "stripe_dispute_status", "last_error_code", "refund_attempts",
  "created_at", "updated_at", "paid_at", "fulfilled_at", "refunded_at",
];

/** The order columns, optionally qualified with a table alias for joins. */
export function orderColumns(alias = ""): string {
  return ORDER_COLUMN_NAMES.map((column) => `${alias}${column}`).join(", ");
}

export const ORDER_COLUMNS = orderColumns();

export interface OrderRow {
  order_id: string;
  order_type: string;
  product_code: string;
  status: string;
  credits: number | null;
  credits_refunded: number;
  amount_cents: number;
  amount_refunded_cents: number;
  currency: string;
  stripe_payment_intent_id: string | null;
  stripe_checkout_session_id: string | null;
  letter_id: string | null;
  hold_reason: string | null;
  stripe_dispute_status: string | null;
  last_error_code: string | null;
  refund_attempts: number;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  fulfilled_at: Date | null;
  refunded_at: Date | null;
}

export function toOrderView(row: OrderRow): AccountOrderView {
  return {
    orderId: row.order_id,
    orderType: row.order_type,
    productCode: row.product_code,
    status: row.status,
    credits: row.credits,
    creditsRefunded: row.credits_refunded,
    amountCents: row.amount_cents,
    amountRefundedCents: row.amount_refunded_cents,
    currency: row.currency,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    letterId: row.letter_id,
    holdReason: row.hold_reason,
    stripeDisputeStatus: row.stripe_dispute_status,
    lastErrorCode: row.last_error_code,
    refundAttempts: row.refund_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    fulfilledAt: row.fulfilled_at,
    refundedAt: row.refunded_at,
  };
}

export const LETTER_WITH_JOB_SQL = `
  SELECT l.letter_id, l.status, l.mail_type::text AS mail_type, l.funding_type, l.funding_order_id,
         l.credits_cost, l.provider, (l.tracking_id IS NOT NULL) AS has_tracking_id,
         l.created_at, l.sent_at, l.status_updated_at, l.redacted_at,
         j.job_id, j.status AS job_status, j.provider_outcome AS job_provider_outcome,
         j.hold_reason AS job_hold_reason
  FROM letters l
  LEFT JOIN letter_jobs j ON j.letter_id = l.letter_id
`;

export interface LetterRow {
  letter_id: string;
  status: string;
  mail_type: string;
  funding_type: string;
  funding_order_id: string | null;
  credits_cost: number;
  provider: string | null;
  has_tracking_id: boolean;
  created_at: Date;
  sent_at: Date | null;
  status_updated_at: Date | null;
  redacted_at: Date | null;
  job_id: string | null;
  job_status: string | null;
  job_provider_outcome: string | null;
  job_hold_reason: string | null;
}

export function toLetterView(row: LetterRow): AccountLetterView {
  return {
    letterId: row.letter_id,
    status: row.status,
    mailType: row.mail_type,
    fundingType: row.funding_type,
    fundingOrderId: row.funding_order_id,
    creditsCost: row.credits_cost,
    provider: row.provider,
    hasTrackingId: row.has_tracking_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    statusUpdatedAt: row.status_updated_at,
    redactedAt: row.redacted_at,
    jobId: row.job_id,
    jobStatus: row.job_status,
    jobProviderOutcome: row.job_provider_outcome,
    jobHoldReason: row.job_hold_reason,
  };
}

export async function readImageQuota(
  client: AdminSqlClient,
  userId: string,
): Promise<ImageQuotaView> {
  const result = await client.query<{
    allowance: string;
    used: string;
    remaining: string;
    active: string;
  }>(
    `SELECT
       COALESCE(SUM(quantity) FILTER (WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())), 0)::text AS allowance,
       COALESCE(SUM(consumed_quantity), 0)::text AS used,
       COALESCE(SUM(quantity - consumed_quantity) FILTER (WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())), 0)::text AS remaining,
       COUNT(*) FILTER (WHERE status = 'active')::text AS active
     FROM image_entitlements WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return {
    allowance: Number(row?.allowance ?? 0),
    used: Number(row?.used ?? 0),
    remaining: Number(row?.remaining ?? 0),
    activeEntitlements: Number(row?.active ?? 0),
  };
}

export async function readAccountDetail(
  client: AdminSqlClient,
  userId: string,
): Promise<AccountDetail | null> {
  const user = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE user_id = $1`,
    [userId],
  );
  const row = user.rows[0];
  if (!row) return null;

  const available = await client.query<{ available: string }>(
    `SELECT COALESCE(SUM(remaining_amount), 0)::text AS available FROM credit_ledger
     WHERE user_id = $1 AND status = 'active' AND remaining_amount > 0
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId],
  );
  const lots = await client.query<LotRow>(
    `SELECT ${LOT_COLUMNS} FROM credit_ledger WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  const orders = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  const letters = await client.query<LetterRow>(
    `${LETTER_WITH_JOB_SQL} WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 100`,
    [userId],
  );
  const redemptions = await client.query<{
    code: string;
    name: string;
    redeemed_at: Date;
    ledger_id: string;
  }>(
    `SELECT c.code, c.name, r.redeemed_at, r.ledger_id
     FROM promo_redemptions r JOIN promo_campaigns c ON c.campaign_id = r.campaign_id
     WHERE r.user_id = $1 ORDER BY r.redeemed_at DESC LIMIT 50`,
    [userId],
  );
  const tokens = await client.query<{
    token_id: number;
    name: string;
    token_prefix: string;
    status: string;
    expires_at: Date | null;
    last_used_at: Date | null;
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT token_id, name, token_prefix, status::text AS status, expires_at, last_used_at, created_at, revoked_at
     FROM personal_access_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );
  const transactions = await client.query<{
    transaction_id: number;
    amount: number;
    balance_after: number;
    type: string;
    reference_type: string | null;
    reference_id: string | null;
    description: string | null;
    created_at: Date;
  }>(
    `SELECT transaction_id, amount, balance_after, type, reference_type, reference_id, description, created_at
     FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC, transaction_id DESC LIMIT 50`,
    [userId],
  );
  const disputes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM stripe_disputes
     WHERE user_id = $1 AND status NOT IN ('won', 'prevented', 'warning_closed', 'charge_refunded')`,
    [userId],
  );

  return {
    account: toAccountSummary(row, Number(available.rows[0]?.available ?? 0)),
    lots: lots.rows.map(toLotView),
    orders: orders.rows.map(toOrderView),
    letters: letters.rows.map(toLetterView),
    imageQuota: await readImageQuota(client, userId),
    redemptions: redemptions.rows.map((r) => ({
      campaignCode: r.code,
      campaignName: r.name,
      redeemedAt: r.redeemed_at,
      ledgerId: r.ledger_id,
    })),
    tokens: tokens.rows.map((t) => ({
      tokenId: t.token_id,
      name: t.name,
      tokenPrefix: t.token_prefix,
      status: t.status,
      expiresAt: t.expires_at,
      lastUsedAt: t.last_used_at,
      createdAt: t.created_at,
      revokedAt: t.revoked_at,
    })),
    transactions: transactions.rows.map((t) => ({
      transactionId: t.transaction_id,
      amount: t.amount,
      balanceAfter: t.balance_after,
      type: t.type,
      referenceType: t.reference_type,
      referenceId: t.reference_id,
      description: t.description,
      createdAt: t.created_at,
    })),
    openDisputes: Number(disputes.rows[0]?.count ?? 0),
  };
}

/** The audited reveal: the one query that returns the email in clear. */
export async function revealAccountEmail(
  client: AdminSqlClient,
  userId: string,
): Promise<string | null> {
  const result = await client.query<{ email: string }>(
    `SELECT email FROM users WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]?.email ?? null;
}

export interface AccountListItem {
  userId: string;
  emailMasked: string;
  credits: number;
  tier: string;
  createdAt: Date;
  sendsBlockedReason: string | null;
}

export async function listRecentAccounts(
  client: AdminSqlClient,
  limit: number,
): Promise<AccountListItem[]> {
  const result = await client.query<{
    user_id: string;
    email: string;
    credits: number;
    tier: string;
    created_at: Date;
    sends_blocked_reason: string | null;
  }>(
    `SELECT user_id, email, credits, tier::text AS tier, created_at, sends_blocked_reason
     FROM users ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    emailMasked: maskEmail(row.email),
    credits: row.credits,
    tier: row.tier,
    createdAt: row.created_at,
    sendsBlockedReason: row.sends_blocked_reason,
  }));
}

export interface LetterDetail {
  letter: AccountLetterView;
  userId: string;
  history: Array<{
    oldStatus: string | null;
    newStatus: string;
    providerRawStatus: string | null;
    source: string;
    changedAt: Date;
  }>;
  job: JobDetailForLetter | null;
}

export interface JobDetailForLetter {
  jobId: string;
  status: string;
  providerOutcome: string;
  attempts: number;
  maxAttempts: number;
  scheduledAt: Date;
  nextAttemptAt: Date | null;
  lockedAt: Date | null;
  hasProviderOrderId: boolean;
  providerDispatchStartedAt: Date | null;
  heldAt: Date | null;
  holdReason: string | null;
  operatorResolution: string | null;
  resolvedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const JOB_COLUMNS = `
  j.job_id, j.status, j.provider_outcome, j.attempts, j.max_attempts, j.scheduled_at,
  j.next_attempt_at, j.locked_at, (j.provider_order_id IS NOT NULL) AS has_provider_order_id,
  j.provider_dispatch_started_at, j.held_at, j.hold_reason, j.operator_resolution, j.resolved_at,
  left(j.last_error, 200) AS last_error, j.created_at, j.updated_at
`;

export interface JobRow {
  job_id: string;
  status: string;
  provider_outcome: string;
  attempts: number;
  max_attempts: number;
  scheduled_at: Date;
  next_attempt_at: Date | null;
  locked_at: Date | null;
  has_provider_order_id: boolean;
  provider_dispatch_started_at: Date | null;
  held_at: Date | null;
  hold_reason: string | null;
  operator_resolution: string | null;
  resolved_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export function toJobDetail(row: JobRow): JobDetailForLetter {
  return {
    jobId: row.job_id,
    status: row.status,
    providerOutcome: row.provider_outcome,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    scheduledAt: row.scheduled_at,
    nextAttemptAt: row.next_attempt_at,
    lockedAt: row.locked_at,
    hasProviderOrderId: row.has_provider_order_id,
    providerDispatchStartedAt: row.provider_dispatch_started_at,
    heldAt: row.held_at,
    holdReason: row.hold_reason,
    operatorResolution: row.operator_resolution,
    resolvedAt: row.resolved_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function readLetterDetail(
  client: AdminSqlClient,
  letterId: string,
): Promise<LetterDetail | null> {
  const letter = await client.query<LetterRow & { user_id: string }>(
    `SELECT l.user_id, l.letter_id, l.status, l.mail_type::text AS mail_type, l.funding_type, l.funding_order_id,
            l.credits_cost, l.provider, (l.tracking_id IS NOT NULL) AS has_tracking_id,
            l.created_at, l.sent_at, l.status_updated_at, l.redacted_at,
            j.job_id, j.status AS job_status, j.provider_outcome AS job_provider_outcome,
            j.hold_reason AS job_hold_reason
     FROM letters l LEFT JOIN letter_jobs j ON j.letter_id = l.letter_id
     WHERE l.letter_id = $1`,
    [letterId],
  );
  const row = letter.rows[0];
  if (!row) return null;
  const history = await client.query<{
    old_status: string | null;
    new_status: string;
    provider_raw_status: string | null;
    source: string;
    changed_at: Date;
  }>(
    `SELECT old_status, new_status, provider_raw_status, source, changed_at
     FROM letter_status_history WHERE letter_id = $1 ORDER BY changed_at DESC LIMIT 50`,
    [letterId],
  );
  const job = await client.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM letter_jobs j WHERE j.letter_id = $1`,
    [letterId],
  );
  return {
    letter: toLetterView(row),
    userId: row.user_id,
    history: history.rows.map((h) => ({
      oldStatus: h.old_status,
      newStatus: h.new_status,
      providerRawStatus: h.provider_raw_status,
      source: h.source,
      changedAt: h.changed_at,
    })),
    job: job.rows[0] ? toJobDetail(job.rows[0]) : null,
  };
}

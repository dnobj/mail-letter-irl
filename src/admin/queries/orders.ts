import type { AdminSqlClient } from "../database.js";
import {
  LETTER_WITH_JOB_SQL,
  LOT_COLUMNS,
  maskEmail,
  orderColumns,
  toLetterView,
  toLotView,
  toOrderView,
  type AccountLetterView,
  type AccountOrderView,
  type LedgerLotView,
  type LetterRow,
  type LotRow,
  type OrderRow,
} from "./accounts.js";
import { listAlertsForOrder, listWebhookEventsForOrder, type AlertView, type WebhookEventView } from "./alerts.js";
import { listDisputesForOrder, type DisputeView } from "./disputes.js";

const CREDITS_PER_LETTER = 2;

/**
 * The figures an operator needs before touching Stripe for a pack: what the
 * pack held, what is still unspent on the account, what a proportional
 * refund could return. The arithmetic mirrors src/services/packRefundService.ts
 * (floor once on the product), and the lot attribution mirrors its
 * LIVE_LOT_PREDICATE, so the page and the command agree to the cent.
 */
export interface PackFigures {
  lettersInPack: number;
  lettersRemaining: number;
  creditsRemaining: number;
  lettersRefundedBefore: number;
  lettersConsumed: number;
  perLetterCents: number;
  maxProportionalRefundCents: number;
  amountRefundedCents: number;
  refundable: boolean;
  refundableReason: string | null;
}

export interface OrderEventView {
  orderEventId: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: string;
  createdAt: Date;
}

export interface PackRefundView {
  packRefundId: string;
  status: string;
  letters: number;
  credits: number;
  amountCents: number;
  currency: string;
  reasonCode: string;
  hasStripeRefundId: boolean;
  stripeAttempts: number;
  lastErrorCode: string | null;
  failureReason: string | null;
  adminCommandId: string | null;
  submittedAt: Date | null;
  settledAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderDetail {
  order: AccountOrderView;
  userId: string;
  emailMasked: string;
  lots: LedgerLotView[];
  pack: PackFigures | null;
  letters: AccountLetterView[];
  events: OrderEventView[];
  packRefunds: PackRefundView[];
  webhookEvents: WebhookEventView[];
  alerts: AlertView[];
  disputes: DisputeView[];
  holdPreviousStatus: string | null;
  heldAt: Date | null;
  amountKnown: boolean;
}

export function computePackFigures(order: {
  credits: number | null;
  creditsRefunded: number;
  amountCents: number;
  amountRefundedCents: number;
  status: string;
  stripePaymentIntentId: string | null;
  amountKnown: boolean;
}, creditsRemaining: number, lettersConsumed: number): PackFigures | null {
  if (order.credits === null || order.credits <= 0) return null;
  const lettersInPack = order.credits / CREDITS_PER_LETTER;
  const lettersRemaining = Math.floor(creditsRemaining / CREDITS_PER_LETTER);
  const perLetterCents = Math.floor(order.amountCents / lettersInPack);
  const maxProportionalRefundCents = Math.floor(
    (lettersRemaining * order.amountCents) / lettersInPack,
  );
  let refundableReason: string | null = null;
  if (order.credits % CREDITS_PER_LETTER !== 0) refundableReason = "credits are not whole letters";
  else if (!order.stripePaymentIntentId) refundableReason = "no Stripe payment on the order";
  else if (!order.amountKnown) refundableReason = "the paid amount is not known";
  else if (order.status !== "fulfilled") refundableReason = `order status is ${order.status}`;
  else if (lettersRemaining <= 0) refundableReason = "no unspent letters remain";
  return {
    lettersInPack,
    lettersRemaining,
    creditsRemaining,
    lettersRefundedBefore: order.creditsRefunded / CREDITS_PER_LETTER,
    lettersConsumed,
    perLetterCents,
    maxProportionalRefundCents,
    amountRefundedCents: order.amountRefundedCents,
    refundable: refundableReason === null,
    refundableReason,
  };
}

export async function readOrderDetail(
  client: AdminSqlClient,
  orderId: string,
): Promise<OrderDetail | null> {
  const orderResult = await client.query<
    OrderRow & {
      user_id: string;
      email: string;
      hold_previous_status: string | null;
      held_at: Date | null;
      amount_known: boolean;
    }
  >(
    `SELECT ${orderColumns("o.")}, o.user_id, u.email, o.hold_previous_status, o.held_at, o.amount_known
     FROM orders o JOIN users u ON u.user_id = o.user_id
     WHERE o.order_id = $1`,
    [orderId],
  );
  const row = orderResult.rows[0];
  if (!row) return null;
  const order = toOrderView(row);

  // The lots this order funded, attributed the way the refund path attributes
  // them: by order reference or by the checkout session recorded on the lot.
  const lots = await client.query<LotRow>(
    `SELECT ${LOT_COLUMNS} FROM credit_ledger
     WHERE user_id = $1
       AND (source_order_id = $2 OR source_reference_id = $2 OR source_metadata->>'stripe_session_id' = $3)
     ORDER BY created_at ASC LIMIT 50`,
    [row.user_id, orderId, row.stripe_checkout_session_id ?? null],
  );
  const live = await client.query<{ credits: string }>(
    `SELECT COALESCE(SUM(remaining_amount), 0)::text AS credits FROM credit_ledger
     WHERE user_id = $1 AND source_type IN ('purchase', 'adjustment')
       AND (source_reference_id = $2 OR source_metadata->>'stripe_session_id' = $3)
       AND status = 'active' AND remaining_amount > 0
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [row.user_id, orderId, row.stripe_checkout_session_id ?? null],
  );
  const lotIds = lots.rows.map((lot) => lot.ledger_id);

  // Letters that consumed credits from those lots.
  let letters: AccountLetterView[] = [];
  if (row.order_type === "letter_pack" && lotIds.length > 0) {
    const consumed = await client.query<LetterRow>(
      `${LETTER_WITH_JOB_SQL}
       WHERE l.letter_id IN (
         SELECT DISTINCT t.reference_id FROM credit_consumption c
         JOIN credit_transactions t ON t.transaction_id = c.transaction_id
         WHERE c.ledger_id = ANY($1::uuid[]) AND t.reference_type = 'letter' AND t.reference_id IS NOT NULL
       )
       ORDER BY l.created_at DESC LIMIT 100`,
      [lotIds],
    );
    letters = consumed.rows.map(toLetterView);
  } else if (row.letter_id) {
    const funded = await client.query<LetterRow>(
      `${LETTER_WITH_JOB_SQL} WHERE l.letter_id = $1`,
      [row.letter_id],
    );
    letters = funded.rows.map(toLetterView);
  }

  const events = await client.query<{
    order_event_id: string;
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    metadata: unknown;
    created_at: Date;
  }>(
    `SELECT order_event_id, event_type, from_status, to_status, metadata, created_at
     FROM commerce_order_events WHERE order_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [orderId],
  );
  const packRefunds = await client.query<{
    pack_refund_id: string;
    status: string;
    letters: number;
    credits: number;
    amount_cents: number;
    currency: string;
    reason_code: string;
    has_stripe_refund_id: boolean;
    stripe_attempts: number;
    last_error_code: string | null;
    failure_reason: string | null;
    admin_command_id: string | null;
    submitted_at: Date | null;
    settled_at: Date | null;
    failed_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT pack_refund_id, status, letters, credits, amount_cents, currency, reason_code,
            (stripe_refund_id IS NOT NULL) AS has_stripe_refund_id, stripe_attempts, last_error_code,
            failure_reason, admin_command_id, submitted_at, settled_at, failed_at, created_at, updated_at
     FROM commerce_pack_refunds WHERE order_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [orderId],
  );

  const pack =
    row.order_type === "letter_pack"
      ? computePackFigures(
          {
            credits: row.credits,
            creditsRefunded: row.credits_refunded,
            amountCents: row.amount_cents,
            amountRefundedCents: row.amount_refunded_cents,
            status: row.status,
            stripePaymentIntentId: row.stripe_payment_intent_id,
            amountKnown: row.amount_known,
          },
          Number(live.rows[0]?.credits ?? 0),
          letters.length,
        )
      : null;

  return {
    order,
    userId: row.user_id,
    emailMasked: maskEmail(row.email),
    lots: lots.rows.map(toLotView),
    pack,
    letters,
    events: events.rows.map((event) => ({
      orderEventId: event.order_event_id,
      eventType: event.event_type,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      metadata: serializeMetadata(event.metadata),
      createdAt: event.created_at,
    })),
    packRefunds: packRefunds.rows.map((refund) => ({
      packRefundId: refund.pack_refund_id,
      status: refund.status,
      letters: refund.letters,
      credits: refund.credits,
      amountCents: refund.amount_cents,
      currency: refund.currency,
      reasonCode: refund.reason_code,
      hasStripeRefundId: refund.has_stripe_refund_id,
      stripeAttempts: refund.stripe_attempts,
      lastErrorCode: refund.last_error_code,
      failureReason: refund.failure_reason,
      adminCommandId: refund.admin_command_id,
      submittedAt: refund.submitted_at,
      settledAt: refund.settled_at,
      failedAt: refund.failed_at,
      createdAt: refund.created_at,
      updatedAt: refund.updated_at,
    })),
    webhookEvents: await listWebhookEventsForOrder(client, orderId),
    alerts: await listAlertsForOrder(client, orderId),
    disputes: await listDisputesForOrder(client, row.stripe_payment_intent_id),
    holdPreviousStatus: row.hold_previous_status,
    heldAt: row.held_at,
    amountKnown: row.amount_known,
  };
}

function serializeMetadata(value: unknown): string {
  try {
    const text = JSON.stringify(value ?? {});
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return "{}";
  }
}

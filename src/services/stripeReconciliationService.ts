/**
 * Stripe Reconciliation Service
 *
 * Compares Stripe payment records with our credit ledger to identify:
 * - Payments in Stripe that we never credited (missed webhooks)
 * - Credits in our system with no matching Stripe payment (errors/fraud)
 * - Amount mismatches between Stripe and our records
 * - Refunds in Stripe that weren't processed in our system
 *
 * Run this periodically (daily) to catch any discrepancies.
 */

import Stripe from 'stripe';
import { query } from '../db/index.js';
import { classifyDiagnosticError, writeDiagnostic } from '../utils/diagnosticLog.js';

// The shared client (with its timeout/retry bounds) and the shared product
// table. Both used to be private hand-kept duplicates here - the credits map's
// own comment said "must match stripeService.ts", which is the drift shape
// behind #160/#270/#275. Now there is one of each.
import { getStripeClient } from './stripeClient.js';
import { PACK_CREDITS_BY_PRODUCT as PRODUCT_CREDITS } from '../config/products.js';

/**
 * The budget for THIS JOB, not for one call. The shared client is tuned for
 * the interactive paths (10s, 1 retry) and consolidating onto it silently cut
 * this file from stripe-node's 80s/2 default. Restoring it per call meant the
 * next Stripe call added here inherits the checkout bounds by accident - which
 * is exactly what happened to refunds.list, left tight while its sibling was
 * patched (#278 review round 3). Nothing here has a customer waiting, and no
 * call has per-page recovery: one timeout discards the whole run.
 */
export const BACKGROUND_REQUEST_OPTIONS = {
  timeout: 60_000,
  maxNetworkRetries: 2
} as const;

interface ReconciliationResult {
  period: {
    start: Date;
    end: Date;
  };
  summary: {
    stripePayments: number;
    ourCredits: number;
    matched: number;
    missingInOurSystem: number;
    missingInStripe: number;
    amountMismatches: number;
    unprocessedRefunds: number;
  };
  discrepancies: Discrepancy[];
  recommendations: string[];
}

interface Discrepancy {
  type: 'missing_credit' | 'missing_order' | 'missing_stripe' | 'amount_mismatch' | 'unprocessed_refund';
  severity: 'critical' | 'high' | 'medium' | 'low';
  stripeSessionId?: string;
  orderId?: string;
  fundingType?: 'letter_pack' | 'jit_mail';
  ledgerId?: string;
  userId?: string;
  stripeAmount?: number;
  stripeCurrency?: string;
  ourAmount?: number;
  expectedCredits?: number;
  actualCredits?: number;
  message: string;
  suggestedAction: string;
}

/**
 * Reconcile Stripe payments with our credit ledger
 *
 * @param daysBack - Number of days to look back (default 30)
 */
export async function reconcileStripePayments(
  daysBack: number = 30,
  stripe: Stripe = getStripeClient()
): Promise<ReconciliationResult> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  console.log(`🔍 Starting Stripe reconciliation for ${startDate.toISOString()} to ${endDate.toISOString()}`);

  const discrepancies: Discrepancy[] = [];
  let matched = 0;
  let missingInOurSystem = 0;
  let missingInStripe = 0;
  let amountMismatches = 0;
  let unprocessedRefunds = 0;

  // 1. Fetch completed checkout sessions from Stripe
  const stripePayments = new Map<string, {
    sessionId: string;
    userId: string;
    amount: number;
    currency: string;
    credits: number;
    productId: string;
    created: Date;
    paymentStatus: string;
    orderId: string | null;
    orderType: 'letter_pack' | 'jit_mail' | null;
  }>();

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    // `expand: ['data.line_items']` used to be requested here and then never
    // read - maximum server-side latency for data discarded on every page.
    const sessions = await stripe.checkout.sessions.list(
      {
        created: {
          gte: Math.floor(startDate.getTime() / 1000),
          lte: Math.floor(endDate.getTime() / 1000),
        },
        limit: 100,
        starting_after: startingAfter,
      },
      BACKGROUND_REQUEST_OPTIONS
    );

    for (const session of sessions.data) {
      // Support both camelCase (userId) and snake_case (user_id) for backwards compatibility
      const userId = session.metadata?.userId || session.metadata?.user_id || '';
      const orderId = session.metadata?.orderId || session.client_reference_id;
      if (session.payment_status === 'paid' && (userId || orderId)) {
        const productId = session.metadata?.productCode || session.metadata?.productId || session.metadata?.product_id || 'unknown';
        const credits = PRODUCT_CREDITS[productId] || parseInt(session.metadata?.credits || '0', 10) || 0;
        const orderType = session.metadata?.orderType;

        stripePayments.set(session.id, {
          sessionId: session.id,
          userId,
          amount: session.amount_total || 0,
          currency: (session.currency || '').toLowerCase(),
          credits,
          productId,
          created: new Date(session.created * 1000),
          paymentStatus: session.payment_status,
          orderId: orderId || null,
          orderType: orderType === 'letter_pack' || orderType === 'jit_mail' ? orderType : null,
        });
      }
    }

    hasMore = sessions.has_more;
    if (sessions.data.length > 0) {
      startingAfter = sessions.data[sessions.data.length - 1].id;
    }
  }

  console.log(`   Found ${stripePayments.size} paid Stripe sessions`);

  // 2. Fetch credit ledger entries from our database
  const ledgerResult = await query<{
    ledger_id: string;
    user_id: string;
    initial_amount: number;
    source_reference_id: string | null;
    source_type: string;
    created_at: Date;
    order_id: string | null;
    order_type: 'letter_pack' | 'jit_mail' | null;
    stripe_checkout_session_id: string | null;
  }>(
    `SELECT ledger.ledger_id, ledger.user_id, ledger.initial_amount,
            ledger.source_reference_id, ledger.source_type, ledger.created_at,
            orders.order_id, orders.order_type, orders.stripe_checkout_session_id
     FROM credit_ledger AS ledger
     LEFT JOIN orders
       ON orders.order_id = ledger.source_reference_id
       OR (
         ledger.source_reference_id = orders.stripe_checkout_session_id
         AND orders.order_type = 'letter_pack'
       )
     WHERE ledger.source_type = 'purchase'
       AND ledger.created_at >= $1
       AND ledger.created_at <= $2`,
    [startDate, endDate]
  );

  const ourCredits = new Map<string, {
    ledgerId: string;
    userId: string;
    credits: number;
    stripeSessionId: string | null;
    createdAt: Date;
    orderId: string | null;
  }>();

  for (const row of ledgerResult.rows) {
    const sessionId = row.stripe_checkout_session_id ||
      (row.source_reference_id?.startsWith('cs_') ? row.source_reference_id : null);
    if (sessionId && row.order_type !== 'jit_mail') {
      ourCredits.set(sessionId, {
        ledgerId: row.ledger_id,
        userId: row.user_id,
        credits: row.initial_amount,
        stripeSessionId: sessionId,
        createdAt: row.created_at,
        orderId: row.order_id,
      });
    }
  }

  console.log(`   Found ${ourCredits.size} credit ledger entries`);

  const orderResult = await query<{
    order_id: string;
    order_type: 'letter_pack' | 'jit_mail';
    stripe_checkout_session_id: string;
    status: string;
    user_id: string;
    credits: number | null;
    amount_cents: number;
    currency: string;
  }>(
    `SELECT order_id, order_type, stripe_checkout_session_id, status, user_id,
            credits, amount_cents, currency
     FROM orders
     WHERE stripe_checkout_session_id IS NOT NULL
       AND created_at >= ($1::timestamptz AT TIME ZONE 'UTC')
       AND created_at <= ($2::timestamptz AT TIME ZONE 'UTC')`,
    [startDate, endDate]
  );
  const ourOrders = new Map(orderResult.rows.map(row => [row.stripe_checkout_session_id, row]));

  // 3. Compare: Find payments in Stripe that we never credited
  for (const [sessionId, stripePayment] of stripePayments) {
    const order = ourOrders.get(sessionId);
    const fundingType = order?.order_type || stripePayment.orderType;
    if (!order) {
      missingInOurSystem++;
      discrepancies.push({
        type: fundingType === 'jit_mail' ? 'missing_order' : 'missing_credit',
        severity: 'critical',
        stripeSessionId: sessionId,
        orderId: stripePayment.orderId || undefined,
        fundingType: fundingType || undefined,
        userId: stripePayment.userId || undefined,
        stripeAmount: stripePayment.amount,
        expectedCredits: fundingType === 'letter_pack' ? stripePayment.credits : undefined,
        message: 'A completed payment has no corresponding authoritative commerce order',
        suggestedAction: 'Review the payment and replay its Stripe webhook',
      });
      continue;
    }

    const paidOrderState = !['checkout_pending', 'payment_failed', 'cancelled', 'paid']
      .includes(order.status);
    if (stripePayment.amount !== order.amount_cents ||
        stripePayment.currency !== order.currency.toLowerCase()) {
      amountMismatches++;
      discrepancies.push({
        type: 'amount_mismatch',
        severity: 'high',
        stripeSessionId: sessionId,
        orderId: order.order_id,
        fundingType: order.order_type,
        userId: order.user_id,
        stripeAmount: stripePayment.amount,
        stripeCurrency: stripePayment.currency,
        ourAmount: order.amount_cents,
        message: 'Stripe payment amount or currency does not match the authoritative order',
        suggestedAction: 'Do not grant or fulfill; review the signed Stripe session and order'
      });
      continue;
    }
    if (order.order_type === 'jit_mail') {
      if (!paidOrderState) {
        missingInOurSystem++;
        discrepancies.push({
          type: 'missing_order',
          severity: 'critical',
          stripeSessionId: sessionId,
          orderId: order.order_id,
          fundingType: 'jit_mail',
          userId: order.user_id,
          stripeAmount: stripePayment.amount,
          stripeCurrency: stripePayment.currency,
          message: 'A paid JIT checkout has not reached a funded commerce state',
          suggestedAction: 'Replay the Stripe checkout webhook; do not grant pack credits'
        });
        continue;
      }
      matched++;
      continue;
    }

    const ourRecord = ourCredits.get(sessionId);

    if (!ourRecord && !paidOrderState) {
      missingInOurSystem++;
      discrepancies.push({
        type: 'missing_order',
        severity: 'critical',
        stripeSessionId: sessionId,
        orderId: order.order_id,
        fundingType: 'letter_pack',
        userId: order.user_id,
        stripeAmount: stripePayment.amount,
        stripeCurrency: stripePayment.currency,
        expectedCredits: order.credits || undefined,
        message: 'A paid pack checkout has not reached its fulfilled commerce state',
        suggestedAction: 'Replay the Stripe checkout webhook before repairing grants'
      });
    } else if (!ourRecord) {
      // Payment exists in Stripe but not in our system
      missingInOurSystem++;
      discrepancies.push({
        type: 'missing_credit',
        severity: 'critical',
        stripeSessionId: sessionId,
        orderId: order.order_id,
        fundingType: 'letter_pack',
        userId: order.user_id,
        stripeAmount: stripePayment.amount,
        expectedCredits: order.credits || undefined,
        stripeCurrency: stripePayment.currency,
        message: 'A completed payment has no corresponding credit entry',
        suggestedAction: 'Review the missing credit in the Stripe dashboard',
      });
    } else if (ourRecord.credits !== order.credits) {
      // Amount mismatch
      amountMismatches++;
      discrepancies.push({
        type: 'amount_mismatch',
        severity: 'high',
        stripeSessionId: sessionId,
        orderId: order.order_id,
        fundingType: 'letter_pack',
        userId: order.user_id,
        expectedCredits: order.credits || undefined,
        actualCredits: ourRecord.credits,
        message: 'A payment and credit entry have different credit amounts',
        suggestedAction: 'Review the product mapping and adjust credits if required',
      });
    } else {
      matched++;
    }
  }

  // 4. Compare: Find credits in our system with no Stripe payment
  for (const [sessionId, ourRecord] of ourCredits) {
    if (!stripePayments.has(sessionId)) {
      // Credits exist in our system but no matching Stripe payment
      // This could be legitimate (session older than our query window, or test data)
      // Only flag if it looks suspicious (session ID format)
      if (sessionId.startsWith('cs_')) {
        missingInStripe++;
        discrepancies.push({
          type: 'missing_stripe',
          severity: 'medium',
          stripeSessionId: sessionId,
          ledgerId: ourRecord.ledgerId,
          userId: ourRecord.userId,
          actualCredits: ourRecord.credits,
          message: 'A credit entry has no matching payment in the reconciliation window',
          suggestedAction: 'Verify the payment in the Stripe dashboard and environment',
        });
      }
    }
  }

  // 5. Check for refunds in Stripe that weren't processed
  const refunds = await stripe.refunds.list(
    {
      created: {
        gte: Math.floor(startDate.getTime() / 1000),
        lte: Math.floor(endDate.getTime() / 1000),
      },
      limit: 100,
    },
    BACKGROUND_REQUEST_OPTIONS
  );

  for (const refund of refunds.data) {
    if (refund.status === 'succeeded' && refund.payment_intent) {
      const paymentIntentReference = typeof refund.payment_intent === 'string'
        ? refund.payment_intent
        : refund.payment_intent.id;
      // Check if we have a corresponding refund transaction
      const refundCheck = await query<{
        order_id: string;
        order_type: 'letter_pack' | 'jit_mail';
        status: string;
        pack_reversal_recorded: boolean;
      }>(
        `SELECT orders.order_id, orders.order_type, orders.status,
                CASE WHEN orders.order_type = 'letter_pack' THEN EXISTS (
                  SELECT 1 FROM credit_ledger AS reversal
                  WHERE reversal.source_type = 'refund'
                    AND reversal.source_reference_id = orders.order_id
                ) ELSE TRUE END AS pack_reversal_recorded
         FROM orders
         WHERE orders.stripe_payment_intent_id = $1
         ORDER BY orders.created_at DESC LIMIT 1`,
        [paymentIntentReference]
      );

      const matchedRefund = refundCheck.rows[0];
      if (!matchedRefund || matchedRefund.status !== 'refunded' || !matchedRefund.pack_reversal_recorded) {
        unprocessedRefunds++;
        discrepancies.push({
          type: 'unprocessed_refund',
          severity: 'high',
          stripeSessionId: paymentIntentReference,
          orderId: matchedRefund?.order_id,
          fundingType: matchedRefund?.order_type,
          stripeAmount: refund.amount,
          message: 'A completed refund has no corresponding durable commerce reversal',
          suggestedAction: 'Review the funding order, refund state, and any pack-ledger reversal',
        });
      }
    }
  }

  // 6. Generate recommendations
  const recommendations: string[] = [];

  if (missingInOurSystem > 0) {
    recommendations.push(
      `CRITICAL: ${missingInOurSystem} payments in Stripe lack a funded order state or pack grant. ` +
      `Review discrepancies and replay the appropriate commerce transition.`
    );
  }

  if (unprocessedRefunds > 0) {
    recommendations.push(
      `HIGH: ${unprocessedRefunds} refunds in Stripe were not processed. ` +
      `Review and deduct credits from affected users.`
    );
  }

  if (amountMismatches > 0) {
    recommendations.push(
      `HIGH: ${amountMismatches} transactions have amount mismatches. ` +
      `Review the provider amount/currency and authoritative order.`
    );
  }

  if (discrepancies.length === 0) {
    recommendations.push('All Stripe payments reconcile correctly with credit ledger.');
  }

  const result: ReconciliationResult = {
    period: {
      start: startDate,
      end: endDate,
    },
    summary: {
      stripePayments: stripePayments.size,
      ourCredits: ourCredits.size,
      matched,
      missingInOurSystem,
      missingInStripe,
      amountMismatches,
      unprocessedRefunds,
    },
    discrepancies,
    recommendations,
  };

  console.log(`\n📊 Reconciliation Summary:`);
  console.log(`   Stripe payments: ${result.summary.stripePayments}`);
  console.log(`   Our credits: ${result.summary.ourCredits}`);
  console.log(`   Matched: ${result.summary.matched}`);
  console.log(`   Missing in our system: ${result.summary.missingInOurSystem}`);
  console.log(`   Amount mismatches: ${result.summary.amountMismatches}`);
  console.log(`   Unprocessed refunds: ${result.summary.unprocessedRefunds}`);

  if (discrepancies.length > 0) {
    console.log(`\n⚠️  Discrepancies found:`);
    for (const [index, discrepancy] of discrepancies.entries()) {
      writeDiagnostic('warn', 'credits.reconciliation_discrepancy', {
        category: discrepancy.type,
        severity: discrepancy.severity,
        occurrence: index + 1
      });
    }
  }

  return result;
}

/**
 * Auto-fix missing credits from Stripe payments
 * Only fixes 'missing_credit' discrepancies where we're confident
 *
 * @param dryRun - If true, only report what would be fixed
 */
export async function autoFixMissingCredits(dryRun: boolean = true): Promise<{
  wouldFix: number;
  fixed: number;
  errors: string[];
}> {
  const result = await reconcileStripePayments(30);
  const missingCredits = result.discrepancies.filter(d => d.type === 'missing_credit');

  const errors: string[] = [];
  let fixed = 0;

  console.log(`\n🔧 Auto-fix missing credits (dryRun=${dryRun})`);
  console.log(`   Found ${missingCredits.length} missing credit entries`);

  if (dryRun) {
    console.log(`   DRY RUN - no changes will be made`);
    return { wouldFix: missingCredits.length, fixed: 0, errors: [] };
  }

  const { repairFulfilledPackGrant } = await import('./commerceService.js');

  for (const discrepancy of missingCredits) {
    if (!discrepancy.userId || !discrepancy.stripeSessionId || !discrepancy.orderId || !discrepancy.expectedCredits) {
      errors.push('Skipped reconciliation discrepancy with missing required data');
      continue;
    }

    try {
      await repairFulfilledPackGrant({
        orderId: discrepancy.orderId,
        stripeSessionId: discrepancy.stripeSessionId,
        expectedCredits: discrepancy.expectedCredits,
        paidAmountCents: discrepancy.stripeAmount || 0,
        paidCurrency: discrepancy.stripeCurrency || ''
      });

      writeDiagnostic('info', 'credits.reconciliation_fixed', {
        credits: discrepancy.expectedCredits
      });
      fixed++;
    } catch (error) {
      const msg = 'Failed to fix reconciliation discrepancy';
      writeDiagnostic('error', 'credits.reconciliation_fix_failed', {
        errorClass: classifyDiagnosticError(error, 'database_error')
      });
      errors.push(msg);
    }
  }

  return { wouldFix: missingCredits.length, fixed, errors };
}

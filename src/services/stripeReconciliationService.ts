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

// Initialize Stripe client
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-11-20.acacia' as any,
});

// Credit amounts by product ID (must match stripeService.ts)
const PRODUCT_CREDITS: Record<string, number> = {
  'credit-pack-4': 4,
  'credit-pack-10': 10,
  'credit-pack-100': 100,
};

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
  type: 'missing_credit' | 'missing_stripe' | 'amount_mismatch' | 'unprocessed_refund';
  severity: 'critical' | 'high' | 'medium' | 'low';
  stripeSessionId?: string;
  userId?: string;
  stripeAmount?: number;
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
export async function reconcileStripePayments(daysBack: number = 30): Promise<ReconciliationResult> {
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
    credits: number;
    productId: string;
    created: Date;
    paymentStatus: string;
  }>();

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const sessions = await stripe.checkout.sessions.list({
      created: {
        gte: Math.floor(startDate.getTime() / 1000),
        lte: Math.floor(endDate.getTime() / 1000),
      },
      limit: 100,
      starting_after: startingAfter,
      expand: ['data.line_items'],
    });

    for (const session of sessions.data) {
      // Support both camelCase (userId) and snake_case (user_id) for backwards compatibility
      const userId = session.metadata?.userId || session.metadata?.user_id || session.client_reference_id;
      if (session.payment_status === 'paid' && userId) {
        const productId = session.metadata?.productId || session.metadata?.product_id || 'unknown';
        const credits = PRODUCT_CREDITS[productId] || parseInt(session.metadata?.credits || '0', 10) || 0;

        stripePayments.set(session.id, {
          sessionId: session.id,
          userId,
          amount: session.amount_total || 0,
          credits,
          productId,
          created: new Date(session.created * 1000),
          paymentStatus: session.payment_status,
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
  }>(
    `SELECT ledger_id, user_id, initial_amount, source_reference_id, source_type, created_at
     FROM credit_ledger
     WHERE source_type = 'purchase'
       AND created_at >= $1
       AND created_at <= $2`,
    [startDate, endDate]
  );

  const ourCredits = new Map<string, {
    ledgerId: string;
    userId: string;
    credits: number;
    stripeSessionId: string | null;
    createdAt: Date;
  }>();

  for (const row of ledgerResult.rows) {
    if (row.source_reference_id) {
      ourCredits.set(row.source_reference_id, {
        ledgerId: row.ledger_id,
        userId: row.user_id,
        credits: row.initial_amount,
        stripeSessionId: row.source_reference_id,
        createdAt: row.created_at,
      });
    }
  }

  console.log(`   Found ${ourCredits.size} credit ledger entries`);

  // 3. Compare: Find payments in Stripe that we never credited
  for (const [sessionId, stripePayment] of stripePayments) {
    const ourRecord = ourCredits.get(sessionId);

    if (!ourRecord) {
      // Payment exists in Stripe but not in our system
      missingInOurSystem++;
      discrepancies.push({
        type: 'missing_credit',
        severity: 'critical',
        stripeSessionId: sessionId,
        userId: stripePayment.userId,
        stripeAmount: stripePayment.amount,
        expectedCredits: stripePayment.credits,
        message: `Payment ${sessionId} for user ${stripePayment.userId} exists in Stripe but credits were never added`,
        suggestedAction: `Run: addCreditsWithOptions({ userId: '${stripePayment.userId}', credits: ${stripePayment.credits}, sourceType: 'purchase', sourceReferenceId: '${sessionId}' })`,
      });
    } else if (ourRecord.credits !== stripePayment.credits) {
      // Amount mismatch
      amountMismatches++;
      discrepancies.push({
        type: 'amount_mismatch',
        severity: 'high',
        stripeSessionId: sessionId,
        userId: stripePayment.userId,
        expectedCredits: stripePayment.credits,
        actualCredits: ourRecord.credits,
        message: `Credit amount mismatch for ${sessionId}: Stripe expects ${stripePayment.credits} credits, we recorded ${ourRecord.credits}`,
        suggestedAction: `Review and manually adjust credits for user ${stripePayment.userId}`,
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
          userId: ourRecord.userId,
          actualCredits: ourRecord.credits,
          message: `Credit entry ${ourRecord.ledgerId} references Stripe session ${sessionId} which was not found in Stripe`,
          suggestedAction: `Verify session exists in Stripe Dashboard. May be outside query window or in different Stripe account.`,
        });
      }
    }
  }

  // 5. Check for refunds in Stripe that weren't processed
  const refunds = await stripe.refunds.list({
    created: {
      gte: Math.floor(startDate.getTime() / 1000),
      lte: Math.floor(endDate.getTime() / 1000),
    },
    limit: 100,
  });

  for (const refund of refunds.data) {
    if (refund.status === 'succeeded' && refund.payment_intent) {
      // Check if we have a corresponding refund transaction
      const refundCheck = await query<{ transaction_id: number }>(
        `SELECT transaction_id FROM credit_transactions
         WHERE type = 'refund'
           AND description LIKE $1
         LIMIT 1`,
        [`%${refund.id}%`]
      );

      if (refundCheck.rows.length === 0) {
        unprocessedRefunds++;
        discrepancies.push({
          type: 'unprocessed_refund',
          severity: 'high',
          stripeSessionId: refund.payment_intent as string,
          stripeAmount: refund.amount,
          message: `Refund ${refund.id} for ${refund.amount / 100} was processed in Stripe but not reflected in our credit system`,
          suggestedAction: `Process refund manually: deduct credits from affected user`,
        });
      }
    }
  }

  // 6. Generate recommendations
  const recommendations: string[] = [];

  if (missingInOurSystem > 0) {
    recommendations.push(
      `CRITICAL: ${missingInOurSystem} payments in Stripe have no corresponding credits. ` +
      `Review discrepancies and add missing credits.`
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
      `Review product ID to credit mapping.`
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
    for (const d of discrepancies) {
      console.log(`   [${d.severity.toUpperCase()}] ${d.message}`);
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

  // Import addCreditsWithOptions dynamically to avoid circular deps
  const { addCreditsWithOptions } = await import('./creditService.js');

  for (const discrepancy of missingCredits) {
    if (!discrepancy.userId || !discrepancy.stripeSessionId || !discrepancy.expectedCredits) {
      errors.push(`Skipping ${discrepancy.stripeSessionId}: missing required data`);
      continue;
    }

    try {
      await addCreditsWithOptions({
        userId: discrepancy.userId,
        credits: discrepancy.expectedCredits,
        sourceType: 'purchase',
        sourceReferenceId: discrepancy.stripeSessionId,
        description: `Auto-reconciled from Stripe session ${discrepancy.stripeSessionId}`,
        expirationDays: 730, // 2 years
      });

      console.log(`   ✅ Fixed: Added ${discrepancy.expectedCredits} credits to ${discrepancy.userId}`);
      fixed++;
    } catch (error) {
      const msg = `Failed to fix ${discrepancy.stripeSessionId}: ${error}`;
      console.error(`   ❌ ${msg}`);
      errors.push(msg);
    }
  }

  return { wouldFix: missingCredits.length, fixed, errors };
}

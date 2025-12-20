/**
 * Run Stripe reconciliation manually
 * Usage: railway run npx tsx scripts/run-reconciliation.ts
 */

import { reconcileStripePayments, autoFixMissingCredits } from '../src/services/stripeReconciliationService.js';

async function main() {
  console.log('🔍 Running Stripe reconciliation (last 30 days)...\n');

  const result = await reconcileStripePayments(30);

  console.log('\n📊 Summary:');
  console.log(`   Stripe payments found: ${result.summary.stripePayments}`);
  console.log(`   Our credit entries: ${result.summary.ourCredits}`);
  console.log(`   Matched: ${result.summary.matched}`);
  console.log(`   Missing in our system: ${result.summary.missingInOurSystem}`);
  console.log(`   Unprocessed refunds: ${result.summary.unprocessedRefunds}`);

  if (result.discrepancies.length > 0) {
    console.log('\n⚠️  Discrepancies:');
    for (const d of result.discrepancies) {
      console.log(`   [${d.severity.toUpperCase()}] ${d.message}`);
    }
  }

  if (result.summary.missingInOurSystem > 0) {
    console.log('\n🔧 Fixing missing credits...');
    const fixResult = await autoFixMissingCredits(false);
    console.log(`   Would fix: ${fixResult.wouldFix}`);
    console.log(`   Fixed: ${fixResult.fixed}`);
    if (fixResult.errors.length > 0) {
      console.log(`   Errors: ${fixResult.errors.join(', ')}`);
    }
  } else {
    console.log('\n✅ No missing credits to fix!');
  }

  process.exit(0);
}

main().catch(e => {
  console.error('❌ Error:', e);
  process.exit(1);
});

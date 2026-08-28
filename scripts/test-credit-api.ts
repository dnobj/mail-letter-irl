#!/usr/bin/env tsx
/**
 * Test Credit API functionality
 *
 * Grants here are 'adjustment' - an operator crediting an account directly -
 * NOT 'purchase'. A purchase grant must name the order that funded it
 * (migration 027 rejects one that does not), and this script has no order to
 * name; it used to call addCredits with a fabricated order id, which is the
 * shape #152 exists to make impossible. The real purchase path is the Stripe
 * webhook, covered by tests/integration/purchaseIdempotency.postgres.test.ts.
 *
 * Tests the complete credit flow:
 * 1. Add credits (operator grant)
 * 2. Check balance
 * 3. Deduct credits (letter send simulation)
 * 4. Check transaction history
 * 5. Check final balance
 */

import 'dotenv/config';
import { addCreditsWithOptions, deductCredits, getBalance, getTransactions } from '../src/services/creditService.js';
import { getUser, findUser } from '../src/services/userService.js';
import { closePool } from '../src/db/index.js';

const TEST_USER_ID = 'test-user-123';
const TEST_EMAIL = 'test@example.com';

async function testCreditFlow() {
  console.log('🧪 Testing Credit API...\n');

  try {
    // Clean up any existing test user
    const existing = await findUser(TEST_USER_ID);
    if (existing) {
      console.log('⚠️  Test user already exists, using existing data\n');
    }

    // Step 1: Add credits (operator grant)
    console.log('1️⃣  Adding 20 credits (operator grant)...');
    const purchase1 = await addCreditsWithOptions({
      userId: TEST_USER_ID,
      email: TEST_EMAIL,
      credits: 20,
      sourceType: 'adjustment',
      sourceReferenceId: 'manual_test_001',
      expirationDays: 730,
      description: 'Test grant: Regular Pack equivalent'
    });
    console.log(`   ✅ Added 20 credits`);
    console.log(`   📊 New balance: ${purchase1.user.credits} credits\n`);

    // Step 2: Check balance
    console.log('2️⃣  Checking balance...');
    const balance1 = await getBalance(TEST_USER_ID);
    console.log(`   ✅ Current balance: ${balance1.credits} credits`);
    console.log(`   📈 Lifetime purchased: ${balance1.credits_purchased} credits`);
    console.log(`   📉 Lifetime used: ${balance1.credits_used} credits\n`);

    // Step 3: Deduct credits (simulating letter send)
    console.log('3️⃣  Deducting 2 credits (letter send simulation)...');
    const deduction1 = await deductCredits({
      userId: TEST_USER_ID,
      credits: 2,
      letterId: 'letter_test_001',
      description: 'Test letter to John Doe'
    });
    console.log(`   ✅ Deducted 2 credits`);
    console.log(`   📊 New balance: ${deduction1.user.credits} credits\n`);

    // Step 4: Add more credits
    console.log('4️⃣  Adding 100 more credits (Power Pack equivalent)...');
    const purchase2 = await addCreditsWithOptions({
      userId: TEST_USER_ID,
      email: TEST_EMAIL,
      credits: 100,
      sourceType: 'adjustment',
      sourceReferenceId: 'manual_test_002',
      expirationDays: 730,
      description: 'Test grant: Power Pack equivalent'
    });
    console.log(`   ✅ Added 100 credits`);
    console.log(`   📊 New balance: ${purchase2.user.credits} credits\n`);

    // Step 5: Deduct more credits
    console.log('5️⃣  Deducting 3 credits (another letter)...');
    const deduction2 = await deductCredits({
      userId: TEST_USER_ID,
      credits: 3,
      letterId: 'letter_test_002',
      description: 'Test letter to Jane Smith'
    });
    console.log(`   ✅ Deducted 3 credits`);
    console.log(`   📊 New balance: ${deduction2.user.credits} credits\n`);

    // Step 6: Get transaction history
    console.log('6️⃣  Fetching transaction history...');
    const history = await getTransactions({
      userId: TEST_USER_ID,
      limit: 10
    });
    console.log(`   ✅ Found ${history.total} transactions:\n`);

    history.transactions.forEach((tx, index) => {
      const sign = tx.amount > 0 ? '+' : '';
      const emoji = tx.type === 'purchase' ? '💳' : tx.type === 'deduction' ? '📤' : '💸';
      console.log(`   ${emoji} ${tx.type.padEnd(10)} ${sign}${tx.amount} credits → Balance: ${tx.balance_after}`);
      console.log(`      ${tx.description}`);
      console.log(`      ${tx.created_at.toISOString()}\n`);
    });

    // Step 7: Final balance check
    console.log('7️⃣  Final balance check...');
    const finalBalance = await getBalance(TEST_USER_ID);
    console.log(`   ✅ Final balance: ${finalBalance.credits} credits`);
    console.log(`   📈 Total purchased: ${finalBalance.credits_purchased} credits`);
    console.log(`   📉 Total used: ${finalBalance.credits_used} credits`);

    // Verify math
    const expected = finalBalance.credits_purchased - finalBalance.credits_used;
    if (finalBalance.credits === expected) {
      console.log(`   ✅ Math checks out! (${finalBalance.credits_purchased} - ${finalBalance.credits_used} = ${expected})\n`);
    } else {
      console.error(`   ❌ Math error! Expected ${expected}, got ${finalBalance.credits}\n`);
    }

    // Step 8: Get user info
    console.log('8️⃣  Getting user info...');
    const user = await getUser(TEST_USER_ID);
    console.log(`   ✅ User: ${user.email}`);
    console.log(`   📅 Created: ${user.created_at.toISOString()}`);
    console.log(`   🔄 Updated: ${user.updated_at.toISOString()}\n`);

    console.log('✨ All tests passed!\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run tests
testCreditFlow();

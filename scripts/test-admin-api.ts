#!/usr/bin/env tsx
/**
 * Test Admin API
 *
 * Tests admin functionality:
 * 1. Get system stats
 * 2. Get user details
 * 3. Adjust credits (add)
 * 4. Adjust credits (remove)
 * 5. List all users
 *
 * Note: This script tests the admin API directly without HTTP/JWT
 * For HTTP testing with JWT, use curl commands shown at the end
 */

import 'dotenv/config';
import { adjustCredits } from '../src/services/creditService.js';
import { getUser, getAllUsers, getOrCreateUser } from '../src/services/userService.js';
import { query, closePool } from '../src/db/index.js';

const TEST_USER_ID = 'test-user-123';
const TEST_EMAIL = 'test@example.com';
const ADMIN_USER_ID = 'admin-test-user';

async function testAdminAPI() {
  console.log('🔧 Testing Admin API...\n');

  try {
    // Step 1: Ensure test user exists
    console.log('1️⃣  Ensuring test user exists...');
    const user = await getOrCreateUser(TEST_USER_ID, TEST_EMAIL);
    console.log(`   ✅ User: ${user.email}, Balance: ${user.credits} credits\n`);

    // Step 2: Get system stats
    console.log('2️⃣  Getting system stats...');
    const userStats = await query<{ count: string; total_credits: string }>(
      'SELECT COUNT(*) as count, SUM(credits) as total_credits FROM users'
    );
    const txStats = await query<{ total_purchased: string; total_used: string }>(
      `SELECT
         SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_purchased,
         SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as total_used
       FROM credit_transactions`
    );
    console.log(`   ✅ Total Users: ${userStats.rows[0].count}`);
    console.log(`   ✅ Total Credits Held: ${userStats.rows[0].total_credits || 0}`);
    console.log(`   ✅ Credits Purchased: ${txStats.rows[0].total_purchased || 0}`);
    console.log(`   ✅ Credits Used: ${txStats.rows[0].total_used || 0}\n`);

    // Step 3: Add credits (admin adjustment)
    console.log('3️⃣  Adding 50 credits (admin adjustment)...');
    const addResult = await adjustCredits(
      TEST_USER_ID,
      50,
      '[Admin Test] Adding credits for testing'
    );
    console.log(`   ✅ Added 50 credits`);
    console.log(`   📊 New balance: ${addResult.user.credits} credits`);
    console.log(`   📝 Transaction ID: ${addResult.transaction.transaction_id}\n`);

    // Step 4: Remove credits (admin adjustment)
    console.log('4️⃣  Removing 10 credits (admin adjustment)...');
    const removeResult = await adjustCredits(
      TEST_USER_ID,
      -10,
      '[Admin Test] Removing credits for testing'
    );
    console.log(`   ✅ Removed 10 credits`);
    console.log(`   📊 New balance: ${removeResult.user.credits} credits`);
    console.log(`   📝 Transaction ID: ${removeResult.transaction.transaction_id}\n`);

    // Step 5: Get user details with stats
    console.log('5️⃣  Getting user details...');
    const userDetails = await getUser(TEST_USER_ID);
    const txCount = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM credit_transactions WHERE user_id = $1',
      [TEST_USER_ID]
    );
    console.log(`   ✅ User: ${userDetails.email}`);
    console.log(`   💳 Balance: ${userDetails.credits} credits`);
    console.log(`   📈 Purchased: ${userDetails.credits_purchased} credits`);
    console.log(`   📉 Used: ${userDetails.credits_used} credits`);
    console.log(`   📝 Transactions: ${txCount.rows[0].count}\n`);

    // Step 6: List all users
    console.log('6️⃣  Listing all users...');
    const allUsers = await getAllUsers(5, 0);
    console.log(`   ✅ Found ${allUsers.total} total users`);
    allUsers.users.forEach((u, i) => {
      console.log(`   ${i + 1}. ${u.email} - ${u.credits} credits`);
    });
    console.log('');

    // Step 7: Show HTTP test commands
    console.log('7️⃣  HTTP API Testing Commands:\n');
    console.log('📍 Start server: npm run mcp:http\n');
    console.log('🔐 Get JWT token from ChatGPT session (check server logs)\n');
    console.log('Then run these curl commands:\n');
    console.log('# Get system stats');
    console.log('curl http://localhost:8788/api/admin/stats \\');
    console.log('  -H "Authorization: Bearer YOUR_JWT_TOKEN"\n');

    console.log('# Get user details');
    console.log(`curl http://localhost:8788/api/admin/users/${TEST_USER_ID} \\`);
    console.log('  -H "Authorization: Bearer YOUR_JWT_TOKEN"\n');

    console.log('# Adjust credits (add 25)');
    console.log('curl -X POST http://localhost:8788/api/admin/credits/adjust \\');
    console.log('  -H "Authorization: Bearer YOUR_JWT_TOKEN" \\');
    console.log('  -H "Content-Type: application/json" \\');
    console.log('  -d \'{\n    "userId": "test-user-123",\n    "amount": 25,\n    "reason": "Customer service credit"\n  }\'\n');

    console.log('# Adjust credits (remove 5)');
    console.log('curl -X POST http://localhost:8788/api/admin/credits/adjust \\');
    console.log('  -H "Authorization: Bearer YOUR_JWT_TOKEN" \\');
    console.log('  -H "Content-Type: application/json" \\');
    console.log('  -d \'{\n    "userId": "test-user-123",\n    "amount": -5,\n    "reason": "Credit reversal"\n  }\'\n');

    console.log('# List all users');
    console.log('curl http://localhost:8788/api/admin/users?limit=10 \\');
    console.log('  -H "Authorization: Bearer YOUR_JWT_TOKEN"\n');

    console.log('✨ Admin API test complete!\n');
    console.log('⚠️  Remember to add your Auth0 user ID to LETTER_IRL_ADMIN_USER_IDS in .env\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run tests
testAdminAPI();

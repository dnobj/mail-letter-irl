import { query } from '../src/db/index.js';

async function showUsers() {
  const result = await query(`
    SELECT user_id, email, credits, credits_purchased, credits_used, created_at
    FROM users
    ORDER BY created_at DESC
  `);

  console.log('\n=== Users in Database ===\n');
  result.rows.forEach((user, i) => {
    console.log(`${i + 1}. ${user.email}`);
    console.log(`   User ID: ${user.user_id}`);
    console.log(`   Credits: ${user.credits}`);
    console.log(`   Purchased: ${user.credits_purchased}`);
    console.log(`   Used: ${user.credits_used}`);
    console.log(`   Created: ${user.created_at}`);
    console.log('');
  });

  console.log(`Total users: ${result.rows.length}\n`);
  process.exit(0);
}

showUsers().catch(console.error);

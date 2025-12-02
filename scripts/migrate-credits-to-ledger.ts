#!/usr/bin/env npx tsx
/**
 * Migrate Credits to Ledger
 *
 * This script migrates existing user credit balances to the new credit_ledger table.
 * It creates "legacy" ledger entries that never expire for all users with credits > 0.
 *
 * Usage:
 *   npx tsx scripts/migrate-credits-to-ledger.ts
 *   npx tsx scripts/migrate-credits-to-ledger.ts --dry-run
 *   npx tsx scripts/migrate-credits-to-ledger.ts --verify-only
 *
 * Options:
 *   --dry-run      Show what would be migrated without making changes
 *   --verify-only  Only verify the migration was successful (run after migration)
 */

import { query, transaction } from '../src/db/index.js';

interface User {
  user_id: string;
  email: string;
  credits: number;
  credits_purchased: number;
  credits_used: number;
  created_at: Date;
}

interface LedgerEntry {
  ledger_id: string;
  user_id: string;
  initial_amount: number;
  remaining_amount: number;
  source_type: string;
}

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const verifyOnly = args.includes('--verify-only');

async function main() {
  console.log('='.repeat(60));
  console.log('Credit Ledger Migration Script');
  console.log('='.repeat(60));

  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  } else if (verifyOnly) {
    console.log('✓ VERIFY MODE - Checking migration status\n');
  } else {
    console.log('⚠️  LIVE MODE - Changes will be committed\n');
  }

  // Check if credit_ledger table exists
  const tableCheck = await query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'credit_ledger'
    )`
  );

  if (!tableCheck.rows[0].exists) {
    console.error('❌ Error: credit_ledger table does not exist!');
    console.error('   Run the migration 003_credit_ledger.sql first.');
    process.exit(1);
  }

  console.log('✓ credit_ledger table exists\n');

  // Check if there are already legacy entries
  const existingLegacy = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM credit_ledger WHERE source_type = 'legacy'`
  );
  const legacyCount = parseInt(existingLegacy.rows[0].count, 10);

  if (legacyCount > 0) {
    console.log(`⚠️  Found ${legacyCount} existing legacy ledger entries`);

    if (verifyOnly) {
      console.log('   (This is expected in verify mode)\n');
    } else if (!isDryRun) {
      console.log('   Skipping users who already have legacy entries...\n');
    }
  }

  // Get users with credits that don't have legacy entries yet
  const usersQuery = legacyCount > 0
    ? `SELECT u.* FROM users u
       WHERE u.credits > 0
       AND NOT EXISTS (
         SELECT 1 FROM credit_ledger cl
         WHERE cl.user_id = u.user_id AND cl.source_type = 'legacy'
       )`
    : `SELECT * FROM users WHERE credits > 0`;

  const usersResult = await query<User>(usersQuery);
  const users = usersResult.rows;

  console.log(`Found ${users.length} users with credits to migrate\n`);

  if (users.length === 0 && !verifyOnly) {
    console.log('✓ Nothing to migrate - all users already have ledger entries');
    await verify();
    process.exit(0);
  }

  if (verifyOnly) {
    if (users.length > 0) {
      console.log('❌ Migration incomplete - some users still need migration:');
      for (const user of users.slice(0, 5)) {
        console.log(`   - ${user.user_id}: ${user.credits} credits`);
      }
      if (users.length > 5) {
        console.log(`   ... and ${users.length - 5} more`);
      }
    }
    await verify();
    process.exit(users.length > 0 ? 1 : 0);
  }

  // Show preview
  console.log('Users to migrate:');
  console.log('-'.repeat(60));
  for (const user of users.slice(0, 10)) {
    console.log(`  ${user.user_id.substring(0, 30).padEnd(30)} | ${user.credits.toString().padStart(4)} credits | created ${user.created_at.toISOString().split('T')[0]}`);
  }
  if (users.length > 10) {
    console.log(`  ... and ${users.length - 10} more users`);
  }
  console.log('');

  if (isDryRun) {
    console.log('🔍 Dry run complete - no changes made');
    const totalCredits = users.reduce((sum, u) => sum + u.credits, 0);
    console.log(`   Would migrate ${users.length} users with ${totalCredits} total credits`);
    process.exit(0);
  }

  // Perform migration
  console.log('Starting migration...\n');

  let migrated = 0;
  let totalCredits = 0;
  const errors: string[] = [];

  for (const user of users) {
    try {
      await transaction(async (client) => {
        // Create legacy ledger entry
        await client.query(
          `INSERT INTO credit_ledger (
            user_id, initial_amount, remaining_amount, source_type,
            activated_at, expires_at, expiration_policy, status, description
          ) VALUES ($1, $2, $2, 'legacy', $3, NULL, 'never', 'active', $4)`,
          [
            user.user_id,
            user.credits,
            user.created_at,
            'Migrated from legacy credit system',
          ]
        );
      });

      migrated++;
      totalCredits += user.credits;

      if (migrated % 100 === 0) {
        console.log(`   Migrated ${migrated}/${users.length} users...`);
      }
    } catch (error: any) {
      errors.push(`${user.user_id}: ${error.message}`);
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Migration Complete');
  console.log('='.repeat(60));
  console.log(`✓ Migrated: ${migrated} users`);
  console.log(`✓ Total credits: ${totalCredits}`);

  if (errors.length > 0) {
    console.log(`❌ Errors: ${errors.length}`);
    for (const error of errors) {
      console.log(`   - ${error}`);
    }
  }

  console.log('');
  await verify();
}

async function verify() {
  console.log('Verification:');
  console.log('-'.repeat(60));

  // Compare totals
  const userTotal = await query<{ total: string }>(
    'SELECT COALESCE(SUM(credits), 0) as total FROM users'
  );

  const ledgerTotal = await query<{ total: string }>(
    `SELECT COALESCE(SUM(remaining_amount), 0) as total
     FROM credit_ledger
     WHERE status = 'active'
       AND remaining_amount > 0
       AND (expires_at IS NULL OR expires_at > NOW())`
  );

  const userCredits = parseInt(userTotal.rows[0].total, 10);
  const ledgerCredits = parseInt(ledgerTotal.rows[0].total, 10);

  console.log(`  Users table total:  ${userCredits} credits`);
  console.log(`  Ledger table total: ${ledgerCredits} credits`);

  if (userCredits === ledgerCredits) {
    console.log('  ✓ Totals match!');
  } else {
    console.log(`  ❌ Mismatch! Difference: ${userCredits - ledgerCredits}`);
  }

  // Count by source type
  const sourceBreakdown = await query<{ source_type: string; count: string; total: string }>(
    `SELECT source_type, COUNT(*) as count, SUM(remaining_amount) as total
     FROM credit_ledger
     WHERE status = 'active' AND remaining_amount > 0
     GROUP BY source_type`
  );

  console.log('\n  Ledger breakdown by source:');
  for (const row of sourceBreakdown.rows) {
    console.log(`    ${row.source_type}: ${row.count} entries, ${row.total} credits`);
  }

  console.log('');
}

main()
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });

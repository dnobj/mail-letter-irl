#!/usr/bin/env tsx
/**
 * Test database connection
 *
 * Usage: npm run db:test
 */

import 'dotenv/config';
import { testConnection, closePool } from '../src/db/index.js';

async function main() {
  console.log('🧪 Testing database connection...\n');

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set in .env file\n');
    console.log('Add this to your .env file:');
    console.log('DATABASE_URL=postgresql://username:password@host/database\n');
    process.exit(1);
  }

  console.log('📍 Database URL:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'), '\n');

  const success = await testConnection();

  if (success) {
    console.log('\n✅ Database connection successful!\n');
    console.log('Next steps:');
    console.log('  1. Run migrations: npm run db:migrate');
    console.log('  2. Start building APIs!\n');
  } else {
    console.log('\n❌ Database connection failed.\n');
    console.log('Check:');
    console.log('  - DATABASE_URL is correct');
    console.log('  - Database server is running');
    console.log('  - Firewall allows connections\n');
    process.exit(1);
  }

  await closePool();
}

main();

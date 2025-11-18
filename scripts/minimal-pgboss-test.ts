#!/usr/bin/env tsx
/**
 * Minimal pg-boss test to debug send() returning null
 */

import 'dotenv/config';
import PgBoss from 'pg-boss';

async function test() {
  console.log('🧪 Testing pg-boss minimal setup...\n');

  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    schema: 'pgboss',
    noScheduling: false,  // Enable scheduling
    noSupervisor: false,  // Enable supervisor
    monitorStateIntervalSeconds: 10
  });

  // Listen for errors
  boss.on('error', (error) => {
    console.error('PG-BOSS ERROR:', error);
  });

  boss.on('monitor-states', (states) => {
    console.log('Monitor states:', states);
  });

  console.log('Starting boss...');
  await boss.start();
  console.log('Boss started!');

  console.log('\nTrying to send a job...');
  const jobId = await boss.send('test-queue', { test: 'data' });
  console.log('Job ID returned:', jobId);
  console.log('Type:', typeof jobId);

  await boss.stop();
  process.exit(0);
}

test().catch(console.error);

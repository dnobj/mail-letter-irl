#!/usr/bin/env tsx
/**
 * Test PostGrid Provider Integration
 *
 * This script validates the PostGrid API connection and optionally sends a test letter.
 */

import 'dotenv/config';
import { getLetterProvider } from '../src/services/providers/index.js';

async function testPostGrid() {
  console.log('🧪 Testing PostGrid Provider Integration\n');

  try {
    // Get the configured provider
    console.log('📦 Initializing provider...');
    const provider = getLetterProvider();
    console.log(`✅ Provider loaded: ${provider.config.displayName}\n`);

    // Validate connection
    console.log('🔌 Validating API connection...');
    const isValid = await provider.validateConnection();

    if (!isValid) {
      console.error('❌ Connection validation failed!');
      console.error('   Check your LETTER_PROVIDER_API_KEY in .env');
      process.exit(1);
    }

    console.log('✅ API connection validated successfully!\n');

    // Check if user wants to send a test letter
    const shouldSendTest = process.argv.includes('--send-test');

    if (!shouldSendTest) {
      console.log('✅ PostGrid is configured correctly!');
      console.log('\n💡 To send a test letter, run:');
      console.log('   npm run test:postgrid -- --send-test\n');
      return;
    }

    // Send a test letter
    console.log('📮 Sending test letter...\n');

    const result = await provider.sendLetter({
      recipientName: 'Test Recipient',
      recipientAddress: {
        line1: '145 Mulberry St',
        line2: 'Apt 1',
        city: 'New York',
        state: 'NY',
        postalCode: '10013',
        country: 'US'
      },
      message: `Hello from Letter IRL!

This is a test letter sent via the PostGrid API integration.

Testing features:
- Provider initialization ✓
- API authentication ✓
- Letter creation ✓
- Status tracking (coming soon)

Best regards,
Letter IRL Test System`,
      senderName: 'Letter IRL Test',
      senderAddress: {
        line1: process.env.LETTER_IRL_DEFAULT_SENDER_ADDRESS || '123 Main St',
        city: process.env.LETTER_IRL_DEFAULT_SENDER_CITY || 'San Francisco',
        state: process.env.LETTER_IRL_DEFAULT_SENDER_STATE || 'CA',
        postalCode: process.env.LETTER_IRL_DEFAULT_SENDER_ZIP || '94102',
        country: 'US'
      }
    });

    if (result.success) {
      console.log('\n✅ Test letter sent successfully!\n');
      console.log('📋 Letter Details:');
      console.log(`   Tracking ID: ${result.trackingId}`);
      console.log(`   Estimated Cost: $${(result.costCents || 0) / 100}`);
      console.log(`   Expected Delivery: ${result.expectedDeliveryDate?.toLocaleDateString() || 'Unknown'}`);

      if (result.detailsUrl) {
        console.log(`   Details URL: ${result.detailsUrl}`);
      }

      if (result.metadata) {
        console.log('\n📊 Metadata:');
        console.log(`   Provider: ${result.metadata.provider}`);
        console.log(`   Mode: ${result.metadata.mode}`);
        console.log(`   Status: ${result.metadata.status}`);
      }

      console.log('\n💡 Next Steps:');
      console.log('   1. Check PostGrid dashboard: https://dashboard.postgrid.com/');
      console.log('   2. View your test letter in the "Letters" section');
      console.log('   3. Remember: Test mode letters are NOT actually mailed!\n');
    } else {
      console.error('\n❌ Failed to send test letter');
      console.error(`   Error: ${result.error}\n`);
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

// Run the test
testPostGrid();

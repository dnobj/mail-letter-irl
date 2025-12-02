#!/usr/bin/env tsx
/**
 * Test PostGrid with Custom Addresses
 *
 * Tests sender and recipient address handling
 */

import 'dotenv/config';
import { getLetterProvider } from '../src/services/providers/index.js';

async function testCustomAddresses() {
  console.log('🧪 Testing PostGrid with Custom Addresses\n');

  try {
    const provider = getLetterProvider();
    console.log(`✅ Provider loaded: ${provider.config.displayName}\n`);

    // Custom sender address (different from default)
    const senderAddress = {
      line1: '1600 Amphitheatre Parkway',
      city: 'Mountain View',
      state: 'CA',
      postalCode: '94043',
      country: 'US'
    };

    // Custom recipient address
    const recipientAddress = {
      line1: '1 Apple Park Way',
      city: 'Cupertino',
      state: 'CA',
      postalCode: '95014',
      country: 'US'
    };

    console.log('📤 Sending test letter with custom addresses...\n');
    console.log('📍 FROM:');
    console.log(`   Letter IRL Team`);
    console.log(`   ${senderAddress.line1}`);
    console.log(`   ${senderAddress.city}, ${senderAddress.state} ${senderAddress.postalCode}\n`);

    console.log('📍 TO:');
    console.log(`   Apple Park Reception`);
    console.log(`   ${recipientAddress.line1}`);
    console.log(`   ${recipientAddress.city}, ${recipientAddress.state} ${recipientAddress.postalCode}\n`);

    const result = await provider.sendLetter({
      recipientName: 'Apple Park Reception',
      recipientAddress,
      senderName: 'Letter IRL Team',
      senderAddress,
      message: `Dear Apple Park Team,

This is a test letter from Letter IRL to verify our address handling system.

We're testing that both custom sender and recipient addresses are properly formatted and sent to the PostGrid API.

SENDER ADDRESS TEST:
- Should show: Letter IRL Team
- Should show: 1600 Amphitheatre Parkway, Mountain View, CA 94043

RECIPIENT ADDRESS TEST:
- Should show: Apple Park Reception
- Should show: 1 Apple Park Way, Cupertino, CA 95014

If you can see this PDF in the PostGrid dashboard with the correct addresses displayed, the test was successful!

Best regards,
The Letter IRL Testing System

P.S. This is a test letter - it will not actually be mailed.`,
      color: false,
      doubleSided: false
    });

    if (result.success) {
      console.log('✅ Test letter sent successfully!\n');
      console.log('📋 Letter Details:');
      console.log(`   Tracking ID: ${result.trackingId}`);
      console.log(`   Estimated Cost: $${(result.costCents || 0) / 100}`);

      if (result.detailsUrl) {
        console.log(`   Details URL: ${result.detailsUrl}`);
      }

      console.log('\n💡 Next Steps:');
      console.log('   1. Go to PostGrid dashboard: https://dashboard.postgrid.com/');
      console.log('   2. Find letter: ' + result.trackingId);
      console.log('   3. Download the PDF');
      console.log('   4. Verify addresses:');
      console.log('      - FROM address shows: Letter IRL Team, 1600 Amphitheatre Parkway, Mountain View, CA 94043');
      console.log('      - TO address shows: Apple Park Reception, 1 Apple Park Way, Cupertino, CA 95014\n');
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

testCustomAddresses();

#!/usr/bin/env tsx
/**
 * Test PostGrid Address Validation
 *
 * Tests address validation with:
 * 1. Valid address (should verify)
 * 2. Address needing correction (should correct)
 * 3. Invalid address (should fail)
 */

import 'dotenv/config';
import { getLetterProvider } from '../src/services/providers/index.js';
import type { AddressValidationInput } from '../src/services/providers/types.js';

async function testAddressValidation() {
  console.log('🧪 Testing PostGrid Address Validation\n');

  try {
    const provider = getLetterProvider();
    console.log(`✅ Provider loaded: ${provider.config.displayName}\n`);

    if (!provider.validateAddress) {
      console.error('❌ Provider does not support address validation');
      process.exit(1);
    }

    // Test 1: Valid address (should verify as-is)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 1: Valid Address (Should Verify)\n');

    const validAddress: AddressValidationInput = {
      line1: '145 Mulberry St',
      city: 'New York',
      state: 'NY',
      postalCode: '10013',
      country: 'US'
    };

    console.log('Input:', validAddress);

    const result1 = await provider.validateAddress(validAddress);

    console.log('\nResult:');
    console.log(`  Status: ${result1.status}`);
    console.log(`  Is Valid: ${result1.isValid}`);

    if (result1.verifiedAddress) {
      console.log('  Verified Address:');
      console.log(`    ${result1.verifiedAddress.line1}`);
      console.log(`    ${result1.verifiedAddress.city}, ${result1.verifiedAddress.state} ${result1.verifiedAddress.postalCode}`);
    }

    if (result1.errors && result1.errors.length > 0) {
      console.log('  Errors:', result1.errors.map(e => e.message).join(', '));
    }

    console.log('');

    // Test 2: Address needing correction (missing zip+4)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 2: Address Needing Correction\n');

    const needsCorrectionAddress: AddressValidationInput = {
      line1: '1600 amphitheatre parkway',  // lowercase, should be corrected
      city: 'mountain view',                // lowercase
      state: 'ca',                          // lowercase
      postalCode: '94043',                  // missing +4
      country: 'US'
    };

    console.log('Input:', needsCorrectionAddress);

    const result2 = await provider.validateAddress(needsCorrectionAddress);

    console.log('\nResult:');
    console.log(`  Status: ${result2.status}`);
    console.log(`  Is Valid: ${result2.isValid}`);

    if (result2.verifiedAddress) {
      console.log('  Verified/Corrected Address:');
      console.log(`    ${result2.verifiedAddress.line1}`);
      console.log(`    ${result2.verifiedAddress.city}, ${result2.verifiedAddress.state} ${result2.verifiedAddress.postalCode}`);

      if (result2.status === 'corrected') {
        console.log('  ✓ Address was automatically corrected');
      }
    }

    if (result2.errors && result2.errors.length > 0) {
      console.log('  Errors:', result2.errors.map(e => e.message).join(', '));
    }

    console.log('');

    // Test 3: Invalid address (should fail)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test 3: Invalid Address (Should Fail)\n');

    const invalidAddress: AddressValidationInput = {
      line1: '123 Fake Street That Does Not Exist',
      city: 'Nowhere',
      state: 'XX',
      postalCode: '00000',
      country: 'US'
    };

    console.log('Input:', invalidAddress);

    const result3 = await provider.validateAddress(invalidAddress);

    console.log('\nResult:');
    console.log(`  Status: ${result3.status}`);
    console.log(`  Is Valid: ${result3.isValid}`);

    if (result3.errors && result3.errors.length > 0) {
      console.log('  Errors:');
      result3.errors.forEach(error => {
        console.log(`    - ${error.field}: ${error.message}`);
      });
    }

    console.log('');

    // Summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Summary:\n');
    console.log(`Test 1 (Valid): ${result1.status} - ${result1.isValid ? '✅' : '❌'}`);
    console.log(`Test 2 (Needs Correction): ${result2.status} - ${result2.isValid ? '✅' : '❌'}`);
    console.log(`Test 3 (Invalid): ${result3.status} - ${!result3.isValid ? '✅ (correctly rejected)' : '❌'}`);

    console.log('\n✅ Address validation tests complete!\n');

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

testAddressValidation();

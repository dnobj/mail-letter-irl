import 'dotenv/config';
import { getLetterProvider } from '../src/services/providers/index.js';

// Force use of PostGrid provider
process.env.LETTER_PROVIDER = 'postgrid';

async function testAddressWithoutZip() {
  console.log('Testing PostGrid address validation WITHOUT zip code...\n');

  const provider = getLetterProvider();

  if (!provider.validateAddress) {
    console.error('❌ Provider does not support address validation');
    process.exit(1);
  }

  // Test address without postal code
  const testAddress = {
    line1: '1600 Amphitheatre Parkway',
    line2: undefined,
    city: 'Mountain View',
    state: 'CA',
    postalCode: undefined, // No zip code!
    country: 'US'
  };

  console.log('Input address (no zip code):');
  console.log(JSON.stringify(testAddress, null, 2));
  console.log('');

  try {
    const result = await provider.validateAddress(testAddress);

    console.log('✅ Validation result:');
    console.log(`   Status: ${result.status}`);
    console.log(`   Is Valid: ${result.isValid}`);

    if (result.verifiedAddress) {
      console.log('\n📬 Verified Address:');
      console.log(`   ${result.verifiedAddress.line1}`);
      if (result.verifiedAddress.line2) {
        console.log(`   ${result.verifiedAddress.line2}`);
      }
      console.log(`   ${result.verifiedAddress.city}, ${result.verifiedAddress.state} ${result.verifiedAddress.postalCode}`);
      console.log(`   Country: ${result.verifiedAddress.country}`);

      if (result.verifiedAddress.postalCode) {
        console.log('\n✅ PostGrid suggested zip code:', result.verifiedAddress.postalCode);
      }
    }

    if (result.errors && result.errors.length > 0) {
      console.log('\n⚠️  Errors:');
      result.errors.forEach(err => {
        console.log(`   ${err.field}: ${err.message}`);
      });
    }

    console.log('\n✅ Test completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testAddressWithoutZip();

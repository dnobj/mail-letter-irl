#!/usr/bin/env tsx
/**
 * Debug PostGrid Address Validation
 * Shows full API response to diagnose issues
 */

import 'dotenv/config';

const apiKey = process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY;

async function debugAddressValidation() {
  console.log('🔍 Debug PostGrid Address Validation\n');
  console.log('API Key:', apiKey?.substring(0, 20) + '...\n');

  const testRequest = {
    address: {
      line1: '145 Mulberry St',
      city: 'New York',
      provinceOrState: 'NY',
      postalOrZip: '10013',
      country: 'US'
    }
  };

  console.log('Request:');
  console.log(JSON.stringify(testRequest, null, 2));
  console.log('');

  const url = 'https://api.postgrid.com/v1/addver/verifications';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey!,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testRequest)
    });

    console.log('Response Status:', response.status);
    console.log('Response Headers:', Object.fromEntries(response.headers.entries()));
    console.log('');

    const data = await response.text();

    console.log('Response Body:');
    try {
      const json = JSON.parse(data);
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(data);
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

debugAddressValidation();

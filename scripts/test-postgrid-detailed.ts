#!/usr/bin/env tsx
import 'dotenv/config';

const apiKey = process.env.LETTER_PROVIDER_API_KEY;
const baseUrl = 'https://api.postgrid.com/print-mail/v1';

async function main() {
  console.log('Testing PostGrid API directly...\n');

  // Send a simple test letter
  const letterRequest = {
    to: {
      firstName: 'John',
      lastName: 'Doe',
      addressLine1: '145 Mulberry St',
      city: 'New York',
      provinceOrState: 'NY',
      postalOrZip: '10013',
      country: 'US'
    },
    from: {
      companyName: 'Letter IRL',
      addressLine1: '123 Main St',
      city: 'San Francisco',
      provinceOrState: 'CA',
      postalOrZip: '94102',
      country: 'US'
    },
    html: '<html><body><p>Hello from Letter IRL! This is a test.</p></body></html>',
    description: 'Test letter from CLI',
    color: false,
    doubleSided: false,
    addressPlacement: 'top_first_page'
  };

  console.log('Sending letter...');
  console.log('Request:', JSON.stringify(letterRequest, null, 2));
  console.log('');

  const response = await fetch(`${baseUrl}/letters`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey!,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(letterRequest)
  });

  const data = await response.json();

  console.log('Response Status:', response.status);
  console.log('Response:', JSON.stringify(data, null, 2));

  if (data.id) {
    console.log('\n✅ Letter created:', data.id);
    console.log('View in dashboard: https://dashboard.postgrid.com/letters/' + data.id);
  }
}

main();

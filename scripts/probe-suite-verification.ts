#!/usr/bin/env tsx
/**
 * Issue #200 discovery probe: how does PostGrid addver actually respond to
 * secondary-unit (suite/apt) addresses? Prints the full raw JSON per case so
 * the failure classifier can be built from observed error keys, not guesses.
 *
 * Uses the same query parameters as PostGridProvider.validateAddress so the
 * responses match what production code sees. Requires
 * POSTGRID_ADDRESS_VERIFICATION_API_KEY in the environment; the key value is
 * never printed.
 */

import 'dotenv/config';

const apiKey = process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY;

interface ProbeCase {
  label: string;
  purpose: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    provinceOrState: string;
    postalOrZip: string;
    country: string;
  };
}

const CASES: ProbeCase[] = [
  {
    label: 'esb-suite-line2',
    purpose: 'The #200 repro: highrise with the suite in line2',
    address: {
      line1: '350 5th Ave',
      line2: 'Suite 8701',
      city: 'New York',
      provinceOrState: 'NY',
      postalOrZip: '10118',
      country: 'US'
    }
  },
  {
    label: 'esb-ste-line2',
    purpose: 'USPS abbreviation form',
    address: {
      line1: '350 5th Ave',
      line2: 'STE 8701',
      city: 'New York',
      provinceOrState: 'NY',
      postalOrZip: '10118',
      country: 'US'
    }
  },
  {
    label: 'esb-suite-in-line1',
    purpose: 'Model-misplacement confound: suite folded into line1',
    address: {
      line1: '350 5th Ave Suite 8701',
      city: 'New York',
      provinceOrState: 'NY',
      postalOrZip: '10118',
      country: 'US'
    }
  },
  {
    label: 'esb-no-suite',
    purpose: 'Highrise-default behavior with no secondary at all',
    address: {
      line1: '350 5th Ave',
      city: 'New York',
      provinceOrState: 'NY',
      postalOrZip: '10118',
      country: 'US'
    }
  },
  {
    label: 'known-good-suite',
    purpose: 'Prove ordinary suites verify (One World Trade tenant floor)',
    address: {
      line1: '285 Fulton St',
      line2: 'Suite 8500',
      city: 'New York',
      provinceOrState: 'NY',
      postalOrZip: '10007',
      country: 'US'
    }
  },
  {
    label: 'apartment',
    purpose: 'Secondary that is an apartment, not a suite',
    address: {
      line1: '129 W 81st St',
      line2: 'Apt 5A',
      city: 'New York',
      provinceOrState: 'NY',
      postalOrZip: '10024',
      country: 'US'
    }
  },
  {
    label: 'garbage-street',
    purpose: 'Genuine hard failure for shape comparison',
    address: {
      line1: '123 Fake Street',
      city: 'Nowhere',
      provinceOrState: 'CA',
      postalOrZip: '90210',
      country: 'US'
    }
  }
];

// Match PostGridProvider.validateAddress exactly (baseUrl + query params).
const URL_ = 'https://api.postgrid.com/v1/addver/verifications?includeDetails=true&properCase=true&geocode=true';

async function probe(testCase: ProbeCase): Promise<void> {
  console.log('='.repeat(72));
  console.log(`CASE: ${testCase.label} — ${testCase.purpose}`);
  console.log('Request address:', JSON.stringify(testCase.address));
  try {
    const response = await fetch(URL_, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey!,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ address: testCase.address })
    });
    console.log('HTTP status:', response.status);
    const text = await response.text();
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }
  } catch (error) {
    console.error('Transport error:', error instanceof Error ? error.message : error);
  }
  console.log('');
}

async function main(): Promise<void> {
  if (!apiKey) {
    console.error(
      'POSTGRID_ADDRESS_VERIFICATION_API_KEY is not set. Put it in .env (never commit it) and re-run.'
    );
    process.exit(1);
  }
  console.log(`Probing ${CASES.length} cases against PostGrid addver\n`);
  for (const testCase of CASES) {
    await probe(testCase);
  }
}

main();

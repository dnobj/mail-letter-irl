#!/usr/bin/env tsx
import 'dotenv/config';
import { getLetterProvider } from '../src/services/providers/index.js';

const letterId = process.argv[2] || 'letter_7d8F4Gu2VTdwC1r1ugxiK8';

async function main() {
  console.log(`Checking letter: ${letterId}\n`);

  const provider = getLetterProvider();

  try {
    const status = await provider.getStatus(letterId);
    console.log('Letter Status:');
    console.log(JSON.stringify(status, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();

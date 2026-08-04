import { syncLetterStatuses } from '../src/services/statusSyncService.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Running status sync (dryRun: ${dryRun})...`);

  const result = await syncLetterStatuses(dryRun, 30);

  console.log('\nResults:');
  console.log(`  Checked: ${result.checked}`);
  console.log(`  Updated: ${result.updated}`);
  console.log(`  Errors: ${result.errors}`);

  if (result.details.length > 0) {
    console.log('\nDetails:');
    for (const detail of result.details) {
      console.log(`  ${detail.letterId}: ${detail.oldStatus} -> ${detail.newStatus} (provider: ${detail.providerStatus})`);
    }
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

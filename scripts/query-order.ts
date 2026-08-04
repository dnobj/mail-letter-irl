import { query } from '../src/db/index.js';

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: npx tsx scripts/query-order.ts <id>');
    process.exit(1);
  }

  // Try to find by various IDs
  console.log(`Searching for ID: ${id}\n`);

  // Try order
  const order = await query('SELECT * FROM orders WHERE order_id = $1', [id]);
  if (order.rows.length > 0) {
    console.log('=== Order ===');
    console.log(JSON.stringify(order.rows[0], null, 2));
  }

  // Try letter
  const letter = await query('SELECT * FROM letters WHERE letter_id = $1', [id]);
  if (letter.rows.length > 0) {
    console.log('\n=== Letter ===');
    console.log(JSON.stringify(letter.rows[0], null, 2));
  }

  // Try draft
  const draft = await query('SELECT * FROM letter_drafts WHERE draft_id = $1', [id]);
  if (draft.rows.length > 0) {
    console.log('\n=== Draft ===');
    // Don't print huge base64 image data
    const d = { ...draft.rows[0] };
    if (d.header_image_data) d.header_image_data = `[BASE64 ${d.header_image_data.length} chars]`;
    if (d.inline_image_data) d.inline_image_data = `[BASE64 ${d.inline_image_data.length} chars]`;
    if (d.content) d.content = JSON.stringify(d.content).substring(0, 500) + '...';
    if (d.recipient) d.recipient = JSON.stringify(d.recipient).substring(0, 200);
    console.log(JSON.stringify(d, null, 2));
  }

  // Try letter job
  const job = await query('SELECT * FROM letter_jobs WHERE job_id = $1', [id]);
  if (job.rows.length > 0) {
    console.log('\n=== Letter Job ===');
    console.log(JSON.stringify(job.rows[0], null, 2));
  }

  // If nothing found
  if (order.rows.length === 0 && letter.rows.length === 0 && draft.rows.length === 0 && job.rows.length === 0) {
    console.log('ID not found in orders, letters, letter_drafts, or letter_jobs tables');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

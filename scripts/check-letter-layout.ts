import { query } from '../src/db/index.js';

async function main() {
  const letterId = process.argv[2];
  if (!letterId) {
    console.error('Usage: npx tsx scripts/check-letter-layout.ts <letter_id>');
    process.exit(1);
  }

  // Get letter with preview_html
  const letter = await query(
    'SELECT letter_id, preview_html, content, tracking_id, status FROM letters WHERE letter_id = $1',
    [letterId]
  );

  if (letter.rows.length === 0) {
    console.log('Letter not found');
    process.exit(1);
  }

  const l = letter.rows[0];

  console.log('=== Letter Info ===');
  console.log('letter_id:', l.letter_id);
  console.log('tracking_id:', l.tracking_id);
  console.log('status:', l.status);

  console.log('\n=== Layout Type ===');
  console.log('layoutType:', l.content?.layoutType || 'text_only');
  console.log('Has inlineImageData:', !!l.content?.inlineImageData);
  console.log('Has headerImageData:', !!l.content?.headerImageData);

  console.log('\n=== Preview HTML ===');
  if (l.preview_html) {
    console.log('Preview HTML length:', l.preview_html.length, 'chars');
    console.log('\nFirst 3000 chars:');
    console.log(l.preview_html.substring(0, 3000));
  } else {
    console.log('No preview HTML stored');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

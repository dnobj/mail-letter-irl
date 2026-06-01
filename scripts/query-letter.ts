import { query } from '../src/db/index.js';

async function main() {
  const letterId = process.argv[2];

  // If no letter ID provided, show recent inline_image letters
  if (!letterId) {
    const r = await query(`
      SELECT
        letter_id,
        tracking_id,
        status,
        content->>'layoutType' as layout_type,
        (content->>'inlineImageData') IS NOT NULL as has_inline_data,
        LENGTH(content->>'inlineImageData') as inline_data_len,
        LENGTH(preview_html) as preview_len,
        created_at
      FROM letters
      WHERE content->>'layoutType' = 'inline_image'
      ORDER BY created_at DESC
      LIMIT 5
    `);
    console.log('Recent inline_image letters:');
    console.log(JSON.stringify(r.rows, null, 2));
    process.exit(0);
  }

  const r = await query(`
    SELECT
      letter_id,
      content->>'layoutType' as layout_type,
      (content->>'inlineImageData') IS NOT NULL as has_inline_data,
      LENGTH(content->>'inlineImageData') as inline_data_len,
      LENGTH(preview_html) as preview_len,
      preview_html LIKE '%inline-image%' as preview_has_inline_class,
      preview_html LIKE '%<img%' as preview_has_img_tag
    FROM letters
    WHERE letter_id = $1
  `, [letterId]);

  if (r.rows.length === 0) {
    console.log('Letter not found');
    process.exit(1);
  }

  console.log(JSON.stringify(r.rows[0], null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

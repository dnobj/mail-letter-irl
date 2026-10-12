# Manifest wording after one tool contract (#688)

Until #688, `/manifest.json` took its tool schemas from a hand-written copy (`src/schemas.ts`), while models read the Zod shapes that `tools/list` serves. The two had drifted. Since #688 the manifest is generated from what `tools/list` serves, so it now says exactly what models read, and the hand-written wording below is gone from it.

**For the owner to decide:** any line in the first table that models *should* read belongs in `src/zodSchemas.ts`, as a `.describe()` on that field. That is a change to what models read, so it goes through the risk-words and model-facing copy tests like any tool text. Nothing here was ever served to a model, so leaving it out changes no model's behaviour.

## Only in the old manifest (148)

Models never saw these: tools/list did not serve them.

| Field | Old manifest |
|---|---|
| `quote_and_preview_letter (input).sender` | Return address (optional - will use saved return address if not provided) |
| `quote_and_preview_letter (input).bodyText` | Letter body. Must not exceed 1600 characters OR 24 lines. Write as continuous paragraphs - do NOT put blank lines between sentences. |
| `quote_and_preview_letter (input).signOff` | Closing/signature (e.g., 'Sincerely, Name') |
| `quote_and_preview_letter (output).giftCard` | Present on a gift send: the card its extra printed page carries |
| `quote_and_preview_letter (output).giftLettersAvailable` | Unsent gift letters on the account, when there are any |
| `quote_and_preview_letter (output).schedule` | The arrival date asked for, when there was one (#535): when it goes to the printer and the dates on offer |
| `quote_and_preview_letter (output).schedule.arriveBy` | The date it should arrive by, YYYY-MM-DD in New York |
| `quote_and_preview_letter (output).schedule.mailOn` | The day it goes to the printer, YYYY-MM-DD |
| `quote_and_preview_letter (output).schedule.releasesAt` | ISO time the hold ends: 09:00 New York time on the mail date, sent to the printer within the hour |
| `quote_and_preview_letter (output).schedule.earliestArrival` | The first arrival date on offer, YYYY-MM-DD |
| `quote_and_preview_letter (output).schedule.latestArrival` | The last arrival date on offer, YYYY-MM-DD |
| `quote_and_preview_letter (output).stationery.dateLine` | The date it prints at the top right, as written |
| `quote_and_preview_letter (output).stationery.monogram` | The initials it prints |
| `quote_and_preview_letter (output).stationery.headline` | The headline it prints above the letter |
| `quote_and_preview_letter (output).lettersRequired` | Letters required from balance (always 1 for standard letter) |
| `quote_and_preview_letter (output).draftId` | Unique draft ID required for send_letter |
| `quote_and_preview_letter (output).draftExpiresAt` | ISO timestamp when draft expires (24h) |
| `quote_and_preview_letter (output).layoutType` | Detected or specified layout type |
| `quote_and_preview_letter (output).headerImageData` | Base64 data URI of processed header image (for widget preview) |
| `quote_and_preview_letter (output).inlineImageData` | Base64 data URI of processed inline image (for widget preview) |
| `quote_and_preview_letter_with_header_image (input).sender` | Return address (optional - will use saved return address if not provided) |
| `quote_and_preview_letter_with_header_image (input).bodyText` | Letter body. Must not exceed 1100 characters OR 15 lines. Write as continuous paragraphs - do NOT put blank lines between sentences. |
| `quote_and_preview_letter_with_header_image (input).signOff` | Closing/signature (e.g., 'Sincerely, Name') |
| `quote_and_preview_letter_with_header_image (input).image` | Header image file attachment (recommended method) |
| `quote_and_preview_letter_with_header_image (input).imageUrl` | URL of header image (fallback if no file attached) |
| `quote_and_preview_letter_with_header_image (output).giftCard` | Present on a gift send: the card its extra printed page carries |
| `quote_and_preview_letter_with_header_image (output).giftLettersAvailable` | Unsent gift letters on the account, when there are any |
| `quote_and_preview_letter_with_header_image (output).schedule` | The arrival date asked for, when there was one (#535): when it goes to the printer and the dates on offer |
| `quote_and_preview_letter_with_header_image (output).schedule.arriveBy` | The date it should arrive by, YYYY-MM-DD in New York |
| `quote_and_preview_letter_with_header_image (output).schedule.mailOn` | The day it goes to the printer, YYYY-MM-DD |
| `quote_and_preview_letter_with_header_image (output).schedule.releasesAt` | ISO time the hold ends: 09:00 New York time on the mail date, sent to the printer within the hour |
| `quote_and_preview_letter_with_header_image (output).schedule.earliestArrival` | The first arrival date on offer, YYYY-MM-DD |
| `quote_and_preview_letter_with_header_image (output).schedule.latestArrival` | The last arrival date on offer, YYYY-MM-DD |
| `quote_and_preview_letter_with_header_image (output).stationery.dateLine` | The date it prints at the top right, as written |
| `quote_and_preview_letter_with_header_image (output).stationery.monogram` | The initials it prints |
| `quote_and_preview_letter_with_header_image (output).stationery.headline` | The headline it prints above the letter |
| `quote_and_preview_letter_with_header_image (output).lettersRequired` | Letters required from balance (always 1 for standard letter) |
| `quote_and_preview_letter_with_header_image (output).draftId` | Unique draft ID required for send_letter |
| `quote_and_preview_letter_with_header_image (output).draftExpiresAt` | ISO timestamp when draft expires (24h) |
| `quote_and_preview_letter_with_header_image (output).layoutType` | Detected or specified layout type |
| `quote_and_preview_letter_with_header_image (output).headerImageData` | Base64 data URI of processed header image (for widget preview) |
| `quote_and_preview_letter_with_header_image (output).inlineImageData` | Base64 data URI of processed inline image (for widget preview) |
| `quote_and_preview_letter_with_image (input).sender` | Return address (optional - will use saved return address if not provided) |
| `quote_and_preview_letter_with_image (input).bodyText` | Letter body. Must not exceed 800 characters OR 12 lines. Write as continuous paragraphs - do NOT put blank lines between sentences. |
| `quote_and_preview_letter_with_image (input).signOff` | Closing/signature (e.g., 'Sincerely, Name') |
| `quote_and_preview_letter_with_image (input).image` | Image file attachment (recommended method) |
| `quote_and_preview_letter_with_image (input).imageUrl` | URL of image (fallback if no file attached) |
| `quote_and_preview_letter_with_image (output).giftCard` | Present on a gift send: the card its extra printed page carries |
| `quote_and_preview_letter_with_image (output).giftLettersAvailable` | Unsent gift letters on the account, when there are any |
| `quote_and_preview_letter_with_image (output).schedule` | The arrival date asked for, when there was one (#535): when it goes to the printer and the dates on offer |
| `quote_and_preview_letter_with_image (output).schedule.arriveBy` | The date it should arrive by, YYYY-MM-DD in New York |
| `quote_and_preview_letter_with_image (output).schedule.mailOn` | The day it goes to the printer, YYYY-MM-DD |
| `quote_and_preview_letter_with_image (output).schedule.releasesAt` | ISO time the hold ends: 09:00 New York time on the mail date, sent to the printer within the hour |
| `quote_and_preview_letter_with_image (output).schedule.earliestArrival` | The first arrival date on offer, YYYY-MM-DD |
| `quote_and_preview_letter_with_image (output).schedule.latestArrival` | The last arrival date on offer, YYYY-MM-DD |
| `quote_and_preview_letter_with_image (output).stationery.dateLine` | The date it prints at the top right, as written |
| `quote_and_preview_letter_with_image (output).stationery.monogram` | The initials it prints |
| `quote_and_preview_letter_with_image (output).stationery.headline` | The headline it prints above the letter |
| `quote_and_preview_letter_with_image (output).lettersRequired` | Letters required from balance (always 1 for standard letter) |
| `quote_and_preview_letter_with_image (output).draftId` | Unique draft ID required for send_letter |
| `quote_and_preview_letter_with_image (output).draftExpiresAt` | ISO timestamp when draft expires (24h) |
| `quote_and_preview_letter_with_image (output).layoutType` | Detected or specified layout type |
| `quote_and_preview_letter_with_image (output).headerImageData` | Base64 data URI of processed header image (for widget preview) |
| `quote_and_preview_letter_with_image (output).inlineImageData` | Base64 data URI of processed inline image (for widget preview) |
| `send_letter (input).draftId` | Draft ID from quote_and_preview_letter |
| `send_letter (input).confirm` | Must be true or request fails |
| `send_letter (output).lettersRemaining` | Number of letters remaining in user's balance |
| `send_letter (output).isRetry` | True if this was an idempotent retry (draft already consumed) |
| `send_letter (output).trackingSupport` | Tracking capability level. 'estimated_only' = periodic status updates available but delivery is estimated (not confirmed). Use get_order_status to check current status. |
| `create_mail_checkout (input).draftId` | Owned pending draft ID from a letter or postcard preview |
| `create_mail_checkout (output).checkoutUrl` | Stripe-hosted checkout URL |
| `create_pack_checkout (input).pack` | Pack size: starter (2 letters), regular (5 letters), power (50 letters) |
| `create_pack_checkout (output).letters` | Letters this pack adds to the balance |
| `create_pack_checkout (output).displayAmount` | Amount formatted for the currency, e.g. 5.00 |
| `list_letter_packs (output).packs[].letters` | Letters this pack adds to the balance |
| `list_letter_packs (output).packs[].displayAmount` | Server-formatted price for this currency |
| `redeem_promo_code (input).code` | The promo code to redeem |
| `redeem_promo_code (output).letters` | Letters added to the balance |
| `redeem_promo_code (output).giftLetters` | Gift letters added: free sends that print a card for the recipient |
| `redeem_promo_code (output).expiresAt` | When the added letters expire, if they do |
| `get_purchase_status (input).orderId` | Commerce order ID returned by checkout |
| `get_account_balance (output).lettersRemaining` | Number of letters remaining in user's balance |
| `get_account_balance (output).lettersExpiringSoon` | Number of letters expiring within 7 days |
| `get_account_balance (output).imageGenerationsRemaining` | Number of explicit image-entitlement units remaining |
| `get_account_balance (output).imageGenerationsAllowance` | Total image-entitlement units granted by qualifying purchases |
| `get_account_balance (output).giftLettersRemaining` | Unsent gift letters: free sends that print a card for the recipient. Not included in lettersRemaining. |
| `list_orders (input).limit` | Maximum number of orders to return (default: 10) |
| `list_orders (output).total` | Total number of orders for this user |
| `list_orders (output).packPurchases` | Letter pack purchases, newest first. Use the orderId with get_purchase_status. |
| `list_orders (output).packPurchases[].letters` | Letters the pack adds to the account |
| `list_orders (output).packPurchases[].purchaseStatus` | submitted means paid and the letters are on the account |
| `list_orders (output).packPurchases[].displayAmount` | Amount formatted for the currency, e.g. 5.00 |
| `list_orders (output).packPurchaseTotal` | Total number of letter pack purchases for this user |
| `quote_and_preview_postcard (input).sender` | Return address (optional - will use saved return address if not provided) |
| `quote_and_preview_postcard (input).size` | Postcard size (currently only 6x9 is supported) |
| `quote_and_preview_postcard (input).image` | Image file attachment for postcard front (recommended method) |
| `quote_and_preview_postcard (input).imageUrl` | REQUIRED when using a hosted image: set this to the imageUrl returned by confirm_uploaded_image (the upload widget flow) or another publicly accessible image URL. This is the URL of the image for the postcard front. |
| `quote_and_preview_postcard (output).giftCard` | Present on a gift send: the card its extra printed page carries |
| `quote_and_preview_postcard (output).giftLettersAvailable` | Unsent gift letters on the account, when there are any |
| `quote_and_preview_postcard (output).schedule` | The arrival date asked for, when there was one (#535): when it goes to the printer and the dates on offer |
| `quote_and_preview_postcard (output).schedule.arriveBy` | The date it should arrive by, YYYY-MM-DD in New York |
| `quote_and_preview_postcard (output).schedule.mailOn` | The day it goes to the printer, YYYY-MM-DD |
| `quote_and_preview_postcard (output).schedule.releasesAt` | ISO time the hold ends: 09:00 New York time on the mail date, sent to the printer within the hour |
| `quote_and_preview_postcard (output).schedule.earliestArrival` | The first arrival date on offer, YYYY-MM-DD |
| `quote_and_preview_postcard (output).schedule.latestArrival` | The last arrival date on offer, YYYY-MM-DD |
| `quote_and_preview_postcard (output).previewFrontHtml` | HTML preview of postcard front (image) |
| `quote_and_preview_postcard (output).previewBackHtml` | HTML preview of postcard back (message) |
| `quote_and_preview_postcard (output).previewHtml` | The postcard as it prints, front and back as SVG, when our renderer drew it (#534) |
| `quote_and_preview_postcard (output).lettersRequired` | Letters required from balance (always 1 for 6x9 postcard) |
| `quote_and_preview_postcard (output).draftId` | Unique draft ID required for send_postcard |
| `quote_and_preview_postcard (output).draftExpiresAt` | ISO timestamp when draft expires (24h) |
| `send_postcard (input).draftId` | Draft ID from quote_and_preview_postcard |
| `send_postcard (input).confirm` | Must be true or request fails |
| `send_postcard (output).lettersRemaining` | Number of letters remaining in user's balance |
| `send_postcard (output).isRetry` | True if this was an idempotent retry (draft already consumed) |
| `send_postcard (output).trackingSupport` | Tracking capability level. 'estimated_only' = periodic status updates available but delivery is estimated (not confirmed). Use get_order_status to check current status. |
| `generate_image_for_mail (input).prompt` | The image the user asked for, in their words. |
| `generate_image_for_mail (input).context` | Optional mail context. |
| `set_return_address (input).name` | Your name as it should appear on letters |
| `set_return_address (input).addressLine1` | Street address (e.g., '123 Main Street') |
| `set_return_address (input).addressLine2` | Apartment, suite, unit, etc. (optional) |
| `set_return_address (input).city` | City name |
| `set_return_address (input).state` | State (2-letter code, e.g., 'CA', 'NY') |
| `set_return_address (input).postalCode` | ZIP code (5-digit or ZIP+4) |
| `set_return_address (input).country` | Country (currently only 'US' is supported) |
| `clear_return_address (input).confirm` | Set to true to confirm clearing the return address |
| `submit_feature_request (input).title` | Brief title for the feature request (max 200 characters) |
| `submit_feature_request (input).description` | Detailed description of the feature you'd like to see (max 2000 characters) |
| `submit_feature_request (input).category` | Category of the feature request. Defaults to 'other' if not specified. |
| `submit_feature_request (input).attemptedAction` | What you were trying to do when you realized this feature was needed (max 255 characters) |
| `submit_feature_request (input).contactEmail` | Email address to contact about this feature request (optional, uses account email if not provided) |
| `submit_feature_request (input).okToContact` | Whether the user consents to being contacted about this feature request |
| `submit_feature_request (output).success` | Whether the feature request was submitted successfully |
| `submit_feature_request (output).requestId` | Unique identifier for the submitted feature request |
| `submit_feature_request (output).message` | Confirmation message to display to the user |
| `submit_feature_request (output).category` | The category assigned to the feature request |
| `upload_image (output).status` | Always 'awaiting_upload' — actual upload happens in widget |
| `upload_image (output).message` | Guidance text for the user based on context |
| `upload_image (output).acceptedFormats` | Accepted image formats (e.g., 'JPEG, PNG, WebP') |
| `upload_image (output).maxSizeMB` | Maximum file size in megabytes |
| `upload_image (output).context` | What the photo is for, as the server read it: 'postcard', 'header_image', 'inline_image', or empty string |
| `upload_image (output).debugEnabled` | True when server-side DEBUG flag enables widget diagnostic logging |
| `upload_image (output).debugEndpoint` | Optional absolute URL for debug beacon ingestion |
| `upload_image (output).cardUploadAvailable` | True when the card may send the photo itself, in an app with no file store (#474) |
| `confirm_uploaded_image (input).imageUrl` | Download URL of the uploaded image |
| `confirm_uploaded_image (output).status` | Always 'ready' — image has been uploaded and URL is available |
| `confirm_uploaded_image (output).imageUrl` | Download URL of the uploaded image |
| `confirm_uploaded_image (output).suggestedNextStep` | Instruction for which preview tool to call next with the imageUrl |

## Worded differently (4)

The new manifest says what tools/list always said.

| Field | Old manifest | Served (now in both) |
|---|---|---|
| `create_pack_checkout (output).checkoutUrl` | Stripe-hosted checkout URL. Present it to the customer as a link to click; nothing opens on its own. | Stripe-hosted checkout URL. Present it to the customer as a link to click; nothing opens on its own (#322). |
| `create_pack_checkout (output).checkoutStartUrl` | Same checkout via Letter IRL's start page, which records the way back into the conversation; used by the card. Present checkoutUrl to the customer. | Same checkout via Letter IRL's start page; used by the card. Present checkoutUrl to the customer. |
| `quote_and_preview_postcard (input).message` | Message for the back of the postcard. It must fit the back: 16 lines, about 500 characters of prose | Must fit the back of the postcard: 16 lines, about 500 characters of prose |
| `get_profile (output).id` | Stable, opaque account id. Unchanged across token refresh, reconnection and scope upgrades; never reassigned. | Stable, opaque account id. Unchanged across token refresh, reconnection and scope upgrades; never reassigned to another profile. |

## New to the manifest (4)

Already served in tools/list; the old manifest lacked them.

| Field | Served |
|---|---|
| `quote_and_preview_letter (input).sender.addressLine2` | Apartment, suite, or unit, e.g. "Suite 8701" - never fold it into addressLine1. |
| `quote_and_preview_letter_with_header_image (input).sender.addressLine2` | Apartment, suite, or unit, e.g. "Suite 8701" - never fold it into addressLine1. |
| `quote_and_preview_letter_with_image (input).sender.addressLine2` | Apartment, suite, or unit, e.g. "Suite 8701" - never fold it into addressLine1. |
| `quote_and_preview_postcard (input).sender.addressLine2` | Apartment, suite, or unit, e.g. "Suite 8701" - never fold it into addressLine1. |

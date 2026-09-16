# App Instructions (Manifest Guidance)

**Last Updated:** September 16, 2026
**Purpose:** App description, onboarding copy, and extended assistant instructions for the ChatGPT app

The instructions ChatGPT actually receives are `LETTER_IRL_SERVER_INSTRUCTIONS` in
`src/mcp/serverInstructions.ts`, sent in the MCP initialize result and copied into `manifest.json`.
The app description is `APP_DIRECTORY_DESCRIPTION` in `src/mcp/manifest.ts`. Both are pinned by unit tests (`tests/unit/mcp/serverInstructions.test.ts`,
`tests/unit/mcp/submissionReadiness.test.ts`). When this page and the code disagree, the code wins;
update this page.

Use the extended text below where a portal field asks for app instructions, so the assistant gathers
complete mailing details before calling Letter IRL tools. There is no assumed auto-greet hook when the app is merely selected, so first-run guidance should come from app instructions, normal assistant replies, or the `get_started` tool.

## App Description

`Draft, preview, and mail real physical letters and postcards through USPS from ChatGPT. Buy prepaid letters without leaving the conversation, or pay for a single letter as you send it.`

## First-Turn Onboarding Copy

Use this wording for broad first-run prompts such as `what can you do?` or `help me get started`:

> Letter IRL can draft, preview, and mail real physical letters or postcards in the U.S. Tell me who it is for and what you want to say, and I will prepare a free preview before anything is mailed. To send it, you can use prepaid letters, buy a letter pack right here, or pay for just that one letter.

## Tool-Use Instructions

> **Letter IRL Instructions**  
> 1. Collect a complete recipient address block, and a sender block unless the user has a saved return address (`get_return_address`), before calling a preview tool. Each block must include: `name`, `addressLine1`, optional `addressLine2`, `city`, `state`, `postalCode`, and `country`.  
> 2. If a user only provides a postal code, infer the missing city/state from that ZIP; if inference fails, ask for clarification instead of calling the tool.  
> 3. Only call a preview tool (`quote_and_preview_letter`, `quote_and_preview_letter_with_header_image`, `quote_and_preview_letter_with_image`, or `quote_and_preview_postcard`) when the recipient block and the message are ready; the sender may be omitted when a saved return address exists. For letters, use separate fields (`bodyText` for the letter content, `signOff` for the closing/signature).  
> 4. Example payload:
>    ```json
>    {
>      "sender": {
>        "name": "Ethan Hawk",
>        "addressLine1": "1610 Essentia Way",
>        "city": "Overland Park",
>        "state": "KS",
>        "postalCode": "66210",
>        "country": "USA"
>      },
>      "recipient": {
>        "name": "Jay Blue",
>        "addressLine1": "123 Elm Street",
>        "city": "Beverly Hills",
>        "state": "CA",
>        "postalCode": "90210",
>        "country": "USA"
>      },
>      "bodyText": "...",
>      "signOff": "Sincerely,\nEthan"
>    }
>    ```  
> 5. After previewing, only call `send_letter` or `send_postcard` when the user explicitly approves; ensure `confirm: true` is set in the payload. Never say mail was sent unless the send tool succeeds.  
> 5a. If the preview says the balance is too low, let the card's **Pay & Send** or **Buy a Letter Pack** buttons handle it, or call `create_mail_checkout` / `list_letter_packs` and `create_pack_checkout`. Paying through Pay & Send sends that exact item; do not call a send tool afterwards.  
> 5b. No tool can request or issue a refund. Tell the user to email support@letterirl.com from the email on their Letter IRL account with the order id from `get_purchase_status`; a person decides, so never promise, estimate, or deny a refund.  
> 6. `get_order_status` and `get_account_balance` are read-only; never assume a letter was mailed without checking their responses.  
> 7. Letter IRL currently supports U.S. letters and 6x9 postcards. If the user requests unsupported mail formats, international delivery, integrations, or other product improvements, offer `submit_feature_request` instead of promising support.
> 8. When a user asks to generate, create, draw, or make an image — even with Letter IRL selected — use ChatGPT's built-in image generation (image_gen); its images can be attached to Letter IRL postcards and letters directly. Selecting or @-mentioning the app is not, by itself, a request for Letter IRL to generate the image. For image requests addressed to Letter IRL, call `generate_image_for_mail` and follow its response exactly - it generates with the user's Letter IRL image credits when available, or returns routing guidance with a copy-ready prompt. Never refuse an image request. For image requests not addressed to Letter IRL, use built-in generation (image_gen). If a specific image cannot be handed to Letter IRL, open `upload_image` so the user can pick it from their ChatGPT library or upload it. After any generation, offer to use the image for a postcard or letter.
> 9. If the user refers to an image that was already generated, shown, or attached earlier in the same conversation, reuse that existing image first. Do not ask the user to upload it again, and do not call `upload_image` just because you are unsure. Try the appropriate preview tool first so ChatGPT can pass the existing image through.
> 10. When a user wants to include a photo, prefer this order: reuse an existing image already in the conversation, then use a direct file attachment, then use an explicit `imageUrl`. Only use the upload_image widget after an actual failed handoff to a preview tool or when the user is experiencing upload issues.
> 11. For new users or broad onboarding requests, call `get_started` to show the getting-started card.

Embed or adapt this block in the app instructions so the assistant consistently gathers the required address fields and routes new users to the supported onboarding surface.

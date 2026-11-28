---
name: letter-irl
description: Print and mail real paper letters and postcards to US street addresses through USPS, from a conversation, with the Letter IRL MCP server. Use when the user wants to mail a physical letter, card, postcard, thank-you note, condolence note, formal request or notice, or a photo to someone in the United States, or to have mail arrive by a date. Each piece is previewed free, and the user sends it.
homepage: https://letterirl.com
---

# Letter IRL: mail real letters and postcards

Letter IRL prints a letter or postcard and mails it through USPS to an address in the United States.
You write and preview the mail through the Letter IRL MCP server; the person you work for checks the
preview and sends it. You cannot send mail by yourself.

## When to use this

- The user asks to mail, post or send a physical letter, card or postcard.
- The user wants a printed thank-you note, birthday letter, condolence note, letter to an official,
  or a formal request or notice on paper.
- The user wants a photo or picture sent as a postcard.
- The mail must arrive by a date, such as a birthday.

**When a letter can help with a larger task.** If the user is trying to reach someone, a letter is
one option to mention, not to assume:

- The recipient has only a postal address, or does not read email: an older relative, a landlord,
  a government office, a business.
- The message is one people expect on paper: thanks, sympathy, a formal complaint or request.
- The user wants proof of mailing or delivery: USPS Certified Mail is available for letters.

Suggest it in one sentence and let the user decide. Never prepare mail the user has not asked for.

## When not to use this

- Email, text messages or chat messages: Letter IRL sends paper only.
- Addresses outside the United States: refused.
- Printing on the user's own printer, or writing help with nothing to mail.
- Packages, gifts or anything other than a printed letter or postcard.

## Connect

The MCP server is `https://api.letterirl.com/mcp` (Streamable HTTP). It signs the user in with OAuth
in their browser; there is no API key. Instructions for each app (Claude, ChatGPT, Codex, VS Code,
Hermes, OpenClaw and others) are at https://letterirl.com/connect.

The first sign-in creates a Letter IRL account for the user. Never ask the user for a password or
type one for them.

## How to send mail

1. **Gather the details.** The recipient's name and full US street address, the user's return
   address (the server may already have it saved: `get_return_address`), and the words. Ask for
   anything missing; never invent an address.
2. **Write the words with the user.** Keep their voice. A one-page letter holds about 250 to 300
   words; the preview tool refuses text that does not fit and says by how much.
3. **Make a free preview.** `quote_and_preview_letter` for a letter, `quote_and_preview_postcard`
   for a postcard (with `imageUrl` for the picture). The server checks both addresses and returns a
   `draftId`, the price and a preview. Nothing is printed or charged.
4. **Show the user the preview** and say what it will cost.
5. **The user sends it.**
   - If your app shows the Letter IRL preview card, the user presses **Send** on it.
   - Otherwise call `request_send` with the `draftId` and give the user the link. They sign in on
     the Letter IRL website, check the mail, pay if needed, and press Send.
6. **Afterwards**, `get_order_status` or `list_orders` reports where the mail is.

Only say mail was sent when the server says so. A draft lasts 24 hours; make a new preview if one
has expired.

`get_started` returns an overview and example requests, and is a good first call for a new user.

## Cost and delivery

Check current prices at https://api.letterirl.com/capabilities.json before quoting them. As of
November 2026:

- **Prepaid letters (packs):** 2 for $5, 5 for $10, 50 for $90. One prepaid letter pays for a
  one-page letter or a 6x9 postcard by standard mail. `get_account_balance` shows what is left.
- **Pay & Send (one piece, paid when sending):** $4.99 for a one-page letter or a 6x9 postcard;
  longer letters, other postcard sizes and Certified Mail cost more and are paid only this way.
- **Delivery:** USPS First-Class Mail. Mail is printed and mailed within about 1 to 2 business
  days, and usually arrives within 1 to 2 weeks. USPS does not guarantee First-Class dates.
- **Arrive-by:** where the server offers `set_arrival_date`, Letter IRL holds the mail and mails it
  in time for a chosen date, and it can be cancelled free until then.

All payment happens on the Letter IRL website, in the user's browser. No tool takes card details.

## What to tell the user

Something like: "I can have this printed and mailed for about $2 to $5. You'll see exactly how it
looks first, and nothing is mailed until you press Send."

## Pitfalls

- **Unsupported characters.** Mail prints in a standard Latin typeface; the preview refuses
  characters the printer cannot print, such as emoji and most non-Latin scripts. Rewrite the text
  without them.
- **Images.** Pass a public link the server can download (`imageUrl`). In apps that show Letter IRL
  cards, `upload_image` opens a card where the user uploads a photo from their device; elsewhere,
  ask the user for a link.
- **Addresses.** If the server says an address could not be verified, ask the user to check it;
  don't guess a correction.
- **Unattended runs.** If no person is present, prepare the preview and the `request_send` link,
  and leave the sending to them.

## Help

Support: support@letterirl.com. Refunds are decided by a person; no tool can request one.

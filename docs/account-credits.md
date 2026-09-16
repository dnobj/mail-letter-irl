# Account and Credits Model

**Last Updated:** September 16, 2026
**Purpose:** How balances, credits and letters relate, and how previews and sends use them

---

## User Account Record

- `users.user_id` is the Auth0 subject (or the PAT owner's subject). All state is scoped to it.
- `users.credits` is a cached balance. The source of truth is the `credit_ledger`: one row per lot,
  each with its own `source_type` (`purchase`, `promo`, `adjustment`, `refund`, `signup_bonus`,
  `legacy`) and expiry. See
  [database-schema.md](database-schema.md).
- Orders, letters, drafts and purchases reference the user by `user_id`.
- With `LETTER_IRL_REQUIRE_AUTH=false` (local development only) every call runs as
  `LETTER_IRL_DEFAULT_USER_ID`. Production refuses to boot with authentication disabled.

## Credits and Letters

- Internally, **one letter or postcard costs 2 credits**. Customers only ever see **letters**; tools
  report `lettersRequired`, `lettersRemaining` and pack sizes in letters.
- Packs grant 4, 10 or 100 credits (2, 5 or 50 letters). Purchased credits are valid for 24 months.
- Every letter is one page; the character limit depends on the layout (1,600 / 1,100 / 800). See
  [pricing-and-credits.md](pricing-and-credits.md#character-limits).
- Credits are consumed FIFO by expiry, and each send records which lots it drew from
  (`credit_consumption`), so a returned send restores the same lots with their original expiry.

## Previews and Sends

- Preview tools are **write** tools: they create a 24-hour draft. They never deduct credits.
- A preview returns `lettersRequired`, `canSendNow` (compared against the caller's balance),
  `reasonCannotSend` when it cannot, and `sendEligibility`, which describes the prepaid path, Pay & Send
  availability and price, and the letter-pack option.
- `send_letter` / `send_postcard` require the `draftId` and `confirm: true`. Inside one transaction
  they lock the draft, deduct the credits, create the order and insert the outbox job. An insufficient
  balance rolls back every effect. See [letter-send-flow.md](letter-send-flow.md).
- Pay & Send (`create_mail_checkout`) never touches the prepaid balance: the payment funds that one
  item.

## Buying and Granting Credits

- Letter packs: `create_pack_checkout` in ChatGPT, or the letterirl.com dashboard. Both use
  Stripe-hosted Checkout; a verified webhook grants the credits.
- Promo codes: `redeem_promo_code`.
- Operator adjustments: the admin panel, in full mode.
- An in-ChatGPT purchase through the Agentic Commerce Protocol is planned for when the platform allows
  it ([acp-implementation-guide.md](acp-implementation-guide.md)).

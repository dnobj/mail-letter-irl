# Account Erasure

**Last Updated:** September 23, 2026
**Purpose:** How a customer's request to delete their account is carried out (#289), and what the operator does by hand

The privacy policy promises deletion on request. Erasure **anonymises** the account: the customer's
content and identity go, and the money records stay, without personal details, for accounting. That is
the owner's decision on #289 (2026-09-23).

---

## What it removes and what it keeps

| Removed | Kept, without personal details |
|---------|--------------------------------|
| The email (replaced by a placeholder) and the saved return address | The account row, as a tombstone, so the kept records keep their links |
| The content, addresses and rendered preview of every letter | Each letter's status, tracking id, cost and dates |
| Drafts (emptied instead when an order refers to one) | Orders, ledger lots and transactions, with their descriptions cleared |
| Retention copies of letters and drafts | Disputes and refunds |
| Personal access tokens, the upload link and feature requests | Gift letters, and gift codes another account redeemed |
| Gift codes nobody has redeemed, so a card already in the post stops working | The admin audit trail, kept two years as the privacy policy says |
| The address a seed code was claimed with | |

Failed mail jobs that an operator could still retry are cancelled, so nothing can mail an empty letter.

The unspent balance and unused gift letters are forfeited. If the customer wants money back, refund
**before** erasing: the erasure blocks sends on the account, and a pack refund refuses a blocked account.

---

## How to run it

1. In the admin panel, find the account (Lookup, by email or id) and open it.
2. Under **Erase account**, choose **Preview erasing this account**. The preview shows what is still in
   flight, what will be removed and what will be kept. The command refuses while any of these holds:
   - an open checkout, or a paid order not yet mailed;
   - a letter or mail job still on its way;
   - an open dispute (a disputed order counts as settled once every dispute on its payment has closed,
     won or lost);
   - a refund in progress;
   - an image generation in flight.

   Wait for it to settle, or settle it deliberately, then preview again. The preview also warns about open
   operational alerts on the account's orders, such as compensation still owed after a dispute. Settle
   those first, because nothing owed can reach the account after it is erased.
3. Elevate, then type the phrase (`CONFIRM <id>` in development, `PRODUCTION ERASE <id>` in production)
   and a reason. **Keep the customer's name and email out of the reason:** the audit trail keeps it for
   two years.
4. Confirming **queues** the erasure. The next hourly maintenance run carries it out. The account page
   then shows one of three things:
   - queued;
   - erased, with counts;
   - refused or failed, with the reason.

   A refused or failed erasure can be queued again.
5. Once it has run, do these by hand:
   - **Auth0:** in the environment's tenant (see [Auth0 Tenant Configuration](auth0-tenant-configuration.md)),
     open User Management → Users, search for the account id, and delete the user. That removes the name
     and email Auth0 holds. Sign-in is already refused without it (see below).
   - Remove the id from `LETTER_IRL_BETA_ALLOWED_SUBJECTS` and `LETTER_IRL_ADMIN_USER_IDS` on the API
     service, if it is listed in either.
   - **Stripe** keeps its own payment records under its own obligations; nothing is deleted there.
     **PostGrid** keeps the letters it printed. If the request covers them, ask PostGrid support to delete
     the letters with the tracking ids shown on the account page.
6. Reply to the customer.

---

## Why it is queued

The panel's operator database role cannot read or change a customer's email, address or letter content
(`src/admin/provisioning.ts`). That is deliberate, and erasure keeps it that way: the panel can only
**ask** for a whole account to be erased, behind the preview, elevation, phrase and audit row, by adding
an `admin_operations` row. The maintenance service carries it out as the database owner, the role the
retention sweep already scrubs content with (`src/services/accountErasureService.ts`). It reads the gate
again under the account's locks first, because the account can change in the hour between.

An unexpected failure is taken back whole and retried an hour later, three attempts in all. A lock
conflict with a send in progress is retried at the next run without counting against them. A refusal by
the gate is not retried: an open dispute can take months, and the operator queues again when it settles.

---

## After erasure

- **Sign-in is refused.** Every sign-in to the erased account gets one sentence pointing at support: in
  ChatGPT, on the website dashboard and through the API, token management included (`AccountErasedError`).
  This does not wait for the Auth0 deletion: a Google or Apple sign-in brings back the same subject, and
  a token issued before the erasure stays valid for up to a day. The dashboard shows the sentence from
  website #36 on; before that it shows an empty account.
- **Sessions already open are refused too.** A legacy SSE session opened before the erasure is refused on
  its next tool call. Two things can still slip through in the moment the erasure commits:
  - A tool call already past sign-in can write one draft. Nothing reads it, and the draft cleanup deletes
    it within about eight days.
  - A pack checkout already past its block check can open an order on the tombstone. If the customer
    pays, refund the payment in the Stripe dashboard: the panel's pack refund refuses a blocked account.
    #449 closes this window.
- **A new account is possible.** The customer can open one with a different sign-in method on the same
  address, because the tombstone no longer holds it.
- **The upload link may linger briefly.** The API process can hold it in memory for up to six hours.
  Nothing can reach it, since every request from the account is refused.

## Reopening an account by hand

If the person wants to come back with the same Google or Apple sign-in, support can reopen the tombstone.
On the owner connection, clear the marker and give the row a confirmed address **in the same statement**.
The `users_erased_tombstone` check refuses a real address while `erased_at` is set:

```sql
UPDATE users SET erased_at = NULL, email = '<their confirmed address>' WHERE user_id = '<id>';
```

Then lift the send block from the panel (**Lift send block**) if nothing else justifies it. Erased content
stays erased. The balance and history are as they were.

---

## Evidence

Manual case `ERASE-01` in [Manual Tests](manual-tests.md). The PostgreSQL suite
`tests/integration/accountErasure.postgres.test.ts` covers the rest against the roles the two halves run as:
- the gate;
- every scrub, and what is kept;
- the retry and savepoint behaviour;
- the sign-in refusal.

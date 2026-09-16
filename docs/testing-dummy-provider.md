# Testing with the Dummy Provider

**Last Updated:** September 16, 2026
**Purpose:** Exercise the send path locally without mailing anything or calling PostGrid

---

## Overview

`DummyProvider` (`src/services/providers/DummyProvider.ts`) stands in for PostGrid. It accepts a
letter after a short delay, returns a `DUMMY-` tracking id, and can simulate provider rejections. It
makes no network calls.

Production refuses to boot with it (`provider.live_provider_required`), and a `provider_routing` row
naming `dummy` is refused in production too.

There is no worker to start. A confirmed send commits the order, the credit deduction and one
`letter_jobs` outbox row in one transaction, then submits that row to the provider immediately in the
same request. `npm run maintenance` recovers anything left due or stale. See
[letter-send-flow.md](letter-send-flow.md).

## Configure

Two things decide which provider a send uses, and **both** must point at the dummy provider:

1. **The routing table.** The outbox resolves the provider per mail type from `provider_routing`
   first (`getProviderForMailType`). Migration 015 seeds all four mail types with `postgrid`, so on a
   freshly migrated database every send goes to PostGrid whatever the environment says. Point the rows
   at the dummy provider in your local database:

   ```sql
   UPDATE provider_routing SET provider = 'dummy', updated_at = NOW();
   ```

2. **The environment.** With no enabled routing row, a send falls back to `LETTER_PROVIDER`, and to
   `postgrid` when that is unset. Address validation and status sync read `LETTER_PROVIDER` directly
   and default to `dummy`. Set it explicitly:

   ```bash
   LETTER_PROVIDER=dummy
   LETTER_PROVIDER_CONFIG={"delayMs":1000,"failureRate":0.05,"costCents":100,"deliveryDays":3,"verbose":true}
   ```

Never run that `UPDATE` against a deployed database. `/readyz` and the provider registry refuse a
`dummy` routing row in production.

Every key is optional; the values above are the defaults. **The default `failureRate` is 5%**, so
roughly one send in twenty fails on purpose. Set `"failureRate":0` when you want every send to succeed.

## Send a test letter

1. Start the server (`npm run dev`); see [SETUP.md](../SETUP.md).
2. Call `quote_and_preview_letter` (or another preview tool), then `send_letter` with the returned
   `draftId` and `confirm: true`. `npm run flow` does both with a sample letter.
3. The log shows `[DummyProvider] Sending letter …` and the tool result reports `accepted`.

The user needs a prepaid balance to take the prepaid path, and a fresh local database has none. The
promo codes seeded by migration 007 grant zero letters, so either insert a `promo_campaigns` row with
a positive `credits_amount` and redeem it with `redeem_promo_code`, or use the admin panel's balance
adjustment, which needs full mode ([admin-panel-guide.md](admin-panel-guide.md)).

## Simulated failures

A simulated failure is returned as a **definite rejection** (`submissionOutcome:
'definite_rejection'`, `retryable: false`): the dummy provider proves no mail exists. The outbox
therefore treats it as terminal, not as something to retry:

- the job moves to `failed` and the letter to `failed`;
- a prepaid send has its letters returned to the credit ledger, exactly once;
- a Pay & Send order moves to `refund_pending`.

```bash
LETTER_PROVIDER_CONFIG={"delayMs":0,"failureRate":1}
```

forces that path on every send. The dummy provider cannot simulate an **ambiguous** outcome (a timeout
or `5xx` after dispatch, which the outbox holds for an operator); that path is covered by the unit and
PostgreSQL suites.

## Inspect the result

```sql
SELECT letter_id, status, provider, tracking_id, cost_cents, expected_delivery
FROM letters ORDER BY created_at DESC LIMIT 5;

SELECT job_id, status, provider_outcome, attempts, last_error
FROM letter_jobs ORDER BY created_at DESC LIMIT 5;
```

`last_error` holds an error class, never provider text (migrations 031 and 032).

## Troubleshooting

- **`LETTER_PROVIDER must be an approved live provider`**: the process thinks it is production. Set
  `LETTER_IRL_DEPLOYMENT_ENVIRONMENT=development`, or run with `NODE_ENV` other than `production`.
- **Sends reach PostGrid, or fail on missing PostGrid credentials:** the `provider_routing` rows still
  name `postgrid`; see Configure.
- **Every send fails:** check `failureRate` in `LETTER_PROVIDER_CONFIG`.
- **`LETTER_PROVIDER_CONFIG` ignored:** it must be valid JSON; outside production an invalid value is
  only a warning (`provider.config_json_invalid`).

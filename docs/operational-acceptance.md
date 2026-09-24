# Operational Acceptance

**Last Updated:** September 23, 2026
**Purpose:** What must be true, and recorded, about running Letter IRL before access opens to everyone (#408)

Launch opens access to everyone on day one (#158). This page records how the running service is watched, stopped and recovered, with the evidence for each. Fill in the Evidence column as each item is done; keep it sanitised (timestamps, commit ids, counts; never secrets or personal data).

## State at launch

Read from the production API's Railway variables on 2026-09-23:

| Setting | Value | Meaning |
|---------|-------|---------|
| `LETTER_IRL_BETA_GATE_ENABLED` | `false` | Open to everyone; no invited cohort (#179) |
| `JIT_PURCHASE_ENABLED` | `true` | Pay & Send is sold |
| `LETTER_IRL_GIFT_LETTERS_ENABLED` | unset (off) | Turned on at launch, with seed campaigns (#158) |
| `CONTENT_RETENTION_MODE` (maintenance) | unset (report only) | Switched to `enforce` for #153, development first |

The daily ceilings (`LETTER_IRL_BETA_DAILY_MAIL_CAP`, `LETTER_IRL_BETA_ACCOUNT_DAILY_MAIL_CAP`, `LETTER_IRL_BETA_ACCOUNT_DAILY_CHARGE_CENTS`, `LETTER_IRL_GIFT_DAILY_SEND_CAP`) are the durable financial limits. They are separate from, and stronger than, the process-local HTTP rate limits; neither stands in for the other.

## Watching it

- **Failures inside a run** raise durable alerts (`commerce_operational_alerts`), shown on the admin panel's `/alerts` page, and a `maintenance.run_failed` line in the maintenance log. The panel's `/maintenance` page shows when each scheduled task last ran.
- **A run that does not happen**, or keeps failing, is caught by the maintenance heartbeat. After a run finishes, maintenance calls `MAINTENANCE_HEARTBEAT_URL`; an external monitor alerts when the calls stop. Setup:
  1. At [healthchecks.io](https://healthchecks.io), create one check per environment: period 1 hour, grace 1 hour, email alerts to the owner.
  2. Set each check's ping URL as `MAINTENANCE_HEARTBEAT_URL` on the maintenance service in each environment: `letter-irl-maintenance` in production, `letter-irl-maintenance-dev` in development (the names in Railway's service list on 2026-09-23). The URL is a capability, so it lives only in Railway.
  3. After the next hourly run, each check shows a ping. The maintenance log says `Heartbeat sent`. An unusable value logs `[config]` and `Heartbeat invalid` on every run instead.
- **Who watches:** the owner, for held mail, refunds and disputes, through the admin panel: `/alerts`, and an order or account found through Lookup.

## Stopping and recovering

| To stop | Set, on the API service | Undo |
|---------|-------------------------|------|
| New sends, and new Pay & Send checkouts | `LETTER_IRL_MAIL_SENDING_ENABLED=false` | Set it back to `true` |
| New Pay & Send checkouts | `JIT_PURCHASE_ENABLED=false` | Set it back to `true` |
| Gift sends | `LETTER_IRL_GIFT_DAILY_SEND_CAP=0` | Restore the cap |

Each change redeploys the service. None of them stops mail already on its way: letters queued in the outbox, their retries, and paid Pay & Send orders being fulfilled still go to the printer on the next maintenance run. Stopping those needs a switch in the outbox dispatcher, which does not exist yet (#444).

Rehearse the first on development, with nothing queued: set it, confirm a new send is refused and nothing reaches PostGrid, set it back, confirm a send works.

## Restore drill

Neon keeps history for point-in-time restore. The drill only reads:

1. In the Neon console, create a branch from the production branch at a past point, one hour ago, named `restore-drill-<date>`.
2. Time it from create to the branch answering a query: that is the recovery time.
3. On the branch, check `SELECT count(*) FROM letters`, `SELECT max(created_at) FROM orders`, and that the newest row of `migrations` is the newest migration. How far back the data reaches is the recovery point.
4. Record both below, then delete the branch.

## Evidence

| Item | Date | Result | Evidence |
|------|------|--------|----------|
| Heartbeat checks created and pinging (both environments) | | | |
| Mail kill switch rehearsed on development | | | |
| Restore drill: recovery time and recovery point | | | |
| Operator for held mail, refunds and disputes confirmed | | | |

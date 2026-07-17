# Company and Account Ownership

Last updated: July 16, 2026

This document is the non-secret source of truth for the organization and account ownership context behind Letter IRL. Keep credentials, API keys, passwords, recovery codes, private tax IDs, and private billing details out of this file.

## Organization Identity

- Registered organization for platform/vendor accounts: `Objective Works`
- Primary organization account email: `dnicholl@objective.works`
- Public product / DBA: `Letter IRL`
- Public website: `https://letterirl.com`
- Support contact: `support@letterirl.com`

Use `Objective Works` as the organization/company identity where a vendor platform asks for the registered organization, with `Letter IRL` as the DBA/product name.

## OpenAI Registration

Letter IRL should be submitted and managed under the OpenAI organization associated with `Objective Works` / `dnicholl@objective.works`, using `Letter IRL` as the app/product name.

Track the exact OpenAI organization, project, owner account, and identity verification status here when confirmed. Do not store secret keys or sensitive account recovery details in documentation.

Current operational assumption:

- OpenAI registered organization name: `Objective Works`
- OpenAI organization ID: `org-sGKDRRMOeTxvkxhnsvnCRa6J`
- OpenAI submission project name: `Mail Letter IRL`
- OpenAI submission project ID: `proj_6tiqBTLBrGtxtdVz6ms1Acdd`
- OpenAI owner/contact account: `dnicholl@objective.works`
- OpenAI app/product name: `Letter IRL`
- OpenAI identity verification status: completed on May 31, 2026

See `docs/chatgpt-app-submission.md` and `docs/app-submission/openai-test-cases.md` for app submission materials and reviewer test cases.

## ChatGPT Testing Accounts

- Dedicated Letter IRL testing ChatGPT account: `dnicholl@letterirl.com`
- Previous testing ChatGPT account: `dnicholl@objective.works`
- Primary personal ChatGPT account: `openai@davidnicholl.com`

Use the `dnicholl@letterirl.com` ChatGPT account for focused Letter IRL app testing and submission prep. Keep it separate from the primary personal ChatGPT account to avoid mixing app-review state, OAuth connections, test conversations, and platform configuration.

ChatGPT account identity and Letter IRL/Auth0 OAuth identity can differ during testing. When debugging quotas, credits, or account-specific behavior, verify the OAuth account returned by app tools such as `get_account_balance` rather than assuming it matches the visible ChatGPT account.

## Related Accounts

| Area | Production / Public Identity | Development / Admin Identity | Notes |
| --- | --- | --- | --- |
| Auth0 | `dnicholl@letterirl.com` | `dnicholl@objective.works` | Separate production and development tenants. See `docs/auth0-tenant-configuration.md`. |
| Railway | `dnicholl@letterirl.com` | Same account, isolated `production` and `development` environments | One Railway project contains separate API, website, maintenance, and bucket resources per environment. |
| Neon | `dnicholl@objective.works` | Same account/project, isolated production and `dev` branches | Keep the two database branches and pooled connection strings isolated. |
| Stripe / ACP | Letter IRL merchant/product identity | Stripe test mode for development | Keep live/test payment contexts separate. See `docs/acp-stripe-integration.md`. |
| PostGrid | Live mail provider configuration | Dummy/test provider configuration | Avoid sending real mail from dev/test flows unless explicitly intended. |

## Maintenance Notes

- Update this file when platform ownership, verification status, or account responsibilities change.
- Prefer linking to detailed setup docs instead of duplicating environment-specific configuration here.
- Keep this document safe to commit and share with future agents.

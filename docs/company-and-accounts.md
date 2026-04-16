# Company and Account Ownership

Last updated: April 16, 2026

This document is the non-secret source of truth for the organization and account ownership context behind Letter IRL. Keep credentials, API keys, passwords, recovery codes, private tax IDs, and private billing details out of this file.

## Organization Identity

- Registered organization for platform/vendor accounts: `objective.works`
- Primary organization account email: `dnicholl@objective.works`
- Public product / DBA: `Letter IRL`
- Public website: `https://letterirl.com`
- Support contact: `support@letterirl.com`

Use `objective.works` as the organization/company identity where a vendor platform asks for the registered organization, with `Letter IRL` as the DBA/product name.

## OpenAI Registration

Letter IRL should be submitted and managed under the OpenAI organization associated with `objective.works` / `dnicholl@objective.works`, using `Letter IRL` as the app/product name.

Track the exact OpenAI organization, project, owner account, and identity verification status here when confirmed. Do not store secret keys or sensitive account recovery details in documentation.

Current operational assumption:

- OpenAI registered organization: `objective.works`
- OpenAI owner/contact account: `dnicholl@objective.works`
- OpenAI app/product name: `Letter IRL`
- OpenAI identity verification status: submitted for organization verification on April 16, 2026; waiting for OpenAI response

See `docs/chatgpt-app-submission.md` and `docs/app-submission/openai-test-cases.md` for app submission materials and reviewer test cases.

## ChatGPT Testing Accounts

- Dedicated Letter IRL testing ChatGPT account: `dnicholl@objective.works`
- Primary personal ChatGPT account: `openai@davidnicholl.com`

Use the `dnicholl@objective.works` ChatGPT account for focused Letter IRL app testing and submission prep. Keep it separate from the primary personal ChatGPT account to avoid mixing app-review state, OAuth connections, test conversations, and platform configuration.

## Related Accounts

| Area | Production / Public Identity | Development / Admin Identity | Notes |
| --- | --- | --- | --- |
| Auth0 | `dnicholl@letterirl.com` | `dnicholl@objective.works` | Separate production and development tenants. See `docs/auth0-tenant-configuration.md`. |
| Railway | Letter IRL production services | Letter IRL development services | Separate backend and website services for prod/dev. See `docs/infrastructure.md`. |
| Neon | Production database/branch | Development database/branch | Keep prod and dev isolated. See `docs/infrastructure.md` and `docs/deployment.md`. |
| Stripe / ACP | Letter IRL merchant/product identity | Stripe test mode for development | Keep live/test payment contexts separate. See `docs/acp-stripe-integration.md`. |
| PostGrid | Live mail provider configuration | Dummy/test provider configuration | Avoid sending real mail from dev/test flows unless explicitly intended. |

## Maintenance Notes

- Update this file when platform ownership, verification status, or account responsibilities change.
- Prefer linking to detailed setup docs instead of duplicating environment-specific configuration here.
- Keep this document safe to commit and share with future agents.

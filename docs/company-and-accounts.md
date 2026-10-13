# Company and Account Ownership

Last updated: October 13, 2026

The non-secret, public part of the organization behind Letter IRL. Which account administers which
service, the OpenAI organization and project IDs, and the testing accounts are kept out of this public
repository (#730): they are the owner's, in `docs/private/company-and-accounts.md` on the owner's machine.

## Organization Identity

- Registered organization for platform/vendor accounts: `Objective Works`
- Public product / DBA: `Letter IRL`
- Public website: `https://letterirl.com`
- Support contact: `support@letterirl.com`

Use `Objective Works` as the organization/company identity where a vendor platform asks for the
registered organization, with `Letter IRL` as the DBA/product name.

Two admin logins exist, and the other docs name them by role: **the organization account** (the
development Auth0 tenant, Neon, the OpenAI organization's owner) and **the production account** (the
production Auth0 tenant, Railway, app testing in ChatGPT).

## OpenAI Registration

Letter IRL is submitted and managed under the OpenAI organization of `Objective Works`, with
`Letter IRL` as the app/product name. Organization identity verification was completed on May 31, 2026.
See `docs/chatgpt-app-submission.md` and `docs/app-submission/openai-test-cases.md` for the submission
materials and reviewer test cases.

## Testing Accounts

App testing uses a dedicated ChatGPT account, kept separate from the owner's personal one so app-review
state, OAuth connections and test conversations do not mix. ChatGPT account identity and Letter IRL/Auth0
identity can differ: when debugging quotas, credits or account-specific behavior, check the account the
app's tools report (`get_account_balance`) rather than assuming it matches the visible ChatGPT account.

## Related Services

| Area | Production | Development | Notes |
| --- | --- | --- | --- |
| Auth0 | Production tenant | Development tenant | Separate tenants. See `docs/auth0-tenant-configuration.md`. |
| Railway | `production` environment | `development` environment | One project with separate API, website, maintenance and bucket resources per environment. |
| Neon | `production` branch | `dev` branch | Keep the two branches and pooled connection strings isolated. |
| Stripe / ACP | Live mode | Test mode | See `docs/acp-stripe-integration.md`. |
| PostGrid | Live mail provider | Test mode | Avoid sending real mail from dev/test flows unless explicitly intended. |

## Maintenance Notes

- Keep account emails, organization and project IDs and recovery details out of this file; they go in
  `docs/private`.
- Prefer linking to detailed setup docs instead of duplicating environment-specific configuration here.

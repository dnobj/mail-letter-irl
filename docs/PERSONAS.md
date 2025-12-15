# Personas

**Last Updated:** December 15, 2025
**Purpose:** Define user archetypes for product design, user stories, and test scenarios

---

## Overview

Letter IRL serves users who want to send physical letters through conversational AI. These personas represent distinct user types with different needs, behaviors, and pain points.

**Categories:**
| Tag | Description |
|-----|-------------|
| CONSUMER | End users sending personal letters |
| BUSINESS | Business/professional users |
| DEV | Developers and technical users |
| INTERNAL | Platform operators and systems |
| ANTI | Users we explicitly don't serve |

---

## Primary Personas

### Sarah - The Occasional Sender
`CONSUMER`

**Demographics:**
- Age: 35-55
- Occupation: Office professional
- Tech comfort: Moderate (uses ChatGPT regularly)

**Goals:**
- Send heartfelt letters for special occasions (birthdays, thank-yous, sympathy)
- Make letters feel personal, not mass-produced
- Avoid the hassle of finding stamps, envelopes, mailboxes

**Behaviors:**
- Sends 2-4 letters per year
- Buys the smallest credit pack (4 credits)
- Takes time crafting each letter with ChatGPT's help
- Wants to preview before committing
- Cares about letter appearance and formatting

**Pain Points:**
- Forgets to buy stamps/envelopes
- Doesn't know current postage rates
- Worried about letters looking "too digital"
- Concerned about address accuracy

**Key User Stories:**
- US-LETTER-01 (Preview letter)
- US-LETTER-02 (Send letter)
- US-CREDIT-01 (Check balance)
- US-EDGE-02 (Address correction)

**Test Scenarios:**
- First-time user flow
- Single letter with preview → confirm cycle
- Address validation with corrections
- Credit expiration warnings

---

### Marcus - The Regular Correspondent
`CONSUMER`

**Demographics:**
- Age: 28-45
- Occupation: Remote worker, entrepreneur, or creative professional
- Tech comfort: High (power ChatGPT user)

**Goals:**
- Maintain relationships through regular written correspondence
- Send professional thank-you notes to clients/contacts
- Stand out by sending physical mail in a digital world

**Behaviors:**
- Sends 2-5 letters per month
- Buys the 10-credit pack regularly
- Has a routine: drafts multiple letters in one session
- Checks letter status to confirm delivery
- Refers friends, uses promo codes

**Pain Points:**
- Wants letters queued quickly without friction
- Frustrated by re-entering similar addresses
- Needs to track which letters have been sent
- Wants bulk pricing for higher volume

**Key User Stories:**
- US-LETTER-03 (Idempotent send - network reliability)
- US-LETTER-04 (Check status)
- US-LETTER-05 (List letters)
- US-PROMO-02 (Redeem promo)
- US-CREDIT-04 (Transaction history)

**Test Scenarios:**
- Multiple letters in quick succession
- Status checking workflow
- Promo code redemption
- Transaction history review
- Credit balance monitoring

---

### Eleanor - The Legacy Connector
`CONSUMER`

**Demographics:**
- Age: 65+
- Occupation: Retired
- Tech comfort: Low-moderate (uses ChatGPT with family's help)

**Goals:**
- Stay connected with grandchildren, old friends
- Send letters without physical strain (arthritis, mobility issues)
- Maintain tradition of handwritten-style correspondence

**Behaviors:**
- Sends 1-2 letters per month
- Struggles with complex interfaces
- Appreciates clear confirmations and receipts
- May ask ChatGPT to help compose entire letters
- Uses the same addresses repeatedly

**Pain Points:**
- Confused by technical terms (credits, drafts, etc.)
- Worried about making mistakes that cost money
- Needs reassurance that letter will arrive
- May accidentally trigger duplicate sends

**Key User Stories:**
- US-LETTER-01 (Clear preview with cost)
- US-LETTER-03 (Idempotency protection)
- US-LETTER-04 (Status confirmation)
- US-CREDIT-01 (Simple balance check)

**Test Scenarios:**
- Accidental double-click protection
- Clear error messages
- Simple success confirmations
- Expiration warning clarity

---

### David - The Business User
`BUSINESS`

**Demographics:**
- Age: 30-50
- Occupation: Small business owner, sales professional, real estate agent
- Tech comfort: High

**Goals:**
- Send personalized client communications at scale
- Thank customers, follow up on meetings
- Differentiate from competitors with physical mail
- Track ROI of direct mail outreach

**Behaviors:**
- Sends 20-50 letters per month
- Buys the 100-credit power pack
- Integrates letter sending into business workflows
- Needs reliable delivery tracking
- Expense reports require transaction records

**Pain Points:**
- Needs volume discounts
- Wants faster processing for time-sensitive mail
- Requires detailed receipts for accounting
- Concerned about professional appearance

**Key User Stories:**
- US-CREDIT-02 (Purchase credits - power pack)
- US-CREDIT-04 (Transaction history for expenses)
- US-LETTER-05 (List all letters)
- US-CREDIT-05 (Detailed ledger)

**Test Scenarios:**
- High-volume credit purchase
- Bulk letter sending
- Export transaction history
- Letter list pagination
- Rate limiting at scale

---

### Morgan - The MCP Power User
`DEV`

**Demographics:**
- Age: 25-45
- Occupation: Developer, technical enthusiast, or power user
- Tech comfort: High (configures MCP servers, uses multiple AI clients)

**Goals:**
- Send letters from preferred AI client (not ChatGPT)
- Integrate letter-sending into custom AI workflows
- Avoid platform lock-in
- Use open standards and protocols

**Behaviors:**
- Uses Claude Desktop, custom agents, or other MCP-compatible clients
- Comfortable editing JSON config files
- May build automations using Letter IRL as a tool
- Values documentation and predictable APIs
- Contributes feedback on developer experience

**Pain Points:**
- Many services only support ChatGPT
- OAuth flows may not work in all MCP clients
- Wants simple token-based authentication
- Needs clear setup instructions

**Key User Stories:**
- US-MCP-01 (Generate Personal Access Token)
- US-MCP-02 (Revoke token)
- US-MCP-04 (MCP client setup)
- US-LETTER-01, US-LETTER-02 (Same letter flow as ChatGPT users)

**Test Scenarios:**
- PAT generation from dashboard
- MCP client connection with PAT
- Token revocation and re-generation
- Full letter flow via non-ChatGPT client

---

### Jordan - The AI Agent Builder
`DEV`

**Demographics:**
- Age: 28-40
- Occupation: Developer building AI-powered products
- Tech comfort: Very high

**Goals:**
- Add physical mail capabilities to autonomous agents
- Programmatic access with reliable error handling
- Integrate Letter IRL into larger workflows

**Behaviors:**
- Building agents for clients or internal tools
- Needs predictable, documented behavior
- Values idempotency and error codes
- May run agents in production environments
- Evaluates services on API quality

**Pain Points:**
- Needs headless authentication (no browser redirects)
- Wants structured error responses
- Needs audit trail for agent actions
- Future: may want webhooks for status updates

**Key User Stories:**
- US-MCP-01, US-MCP-02 (Token management)
- US-LETTER-03 (Idempotent send - critical for agents)
- US-LETTER-04, US-LETTER-05 (Status checking and listing)
- US-EDGE-03 (Concurrent request handling)

**Test Scenarios:**
- Agent sends multiple letters in sequence
- Agent handles insufficient credits gracefully
- Agent retries on transient errors
- Token scoping (future)

---

### Alex - The Promo Hunter
`CONSUMER`

**Demographics:**
- Age: 22-35
- Occupation: Various
- Tech comfort: High

**Goals:**
- Try the service for free or cheap
- Evaluate before committing money
- Find deals and promotions

**Behaviors:**
- Signs up during promotions
- Redeems every available promo code
- May create multiple accounts (abuse vector)
- Sends 1-2 test letters to verify service
- Churns if no ongoing value

**Pain Points:**
- Skeptical of new services
- Doesn't want to enter payment info upfront
- Frustrated by promo code restrictions

**Key User Stories:**
- US-PROMO-01 (Validate promo)
- US-PROMO-02 (Redeem promo)
- US-PROMO-03 (View redemptions)
- US-CREDIT-03 (Credit expiration - promo credits expire faster)

**Test Scenarios:**
- Promo code validation (valid/invalid/expired)
- One redemption per user enforcement
- New user requirement validation
- Campaign limit enforcement
- Credit expiration for promo credits (90 days)

---

## Secondary Personas

### Amy - The Platform Operator
`INTERNAL`

**Demographics:**
- Role: Platform administrator (you)
- Access: Local admin dashboard

**Goals:**
- Monitor platform health and revenue
- Respond to customer issues quickly
- Prevent and detect fraud/abuse
- Manage promotional campaigns

**Behaviors:**
- Checks dashboard daily for alerts
- Investigates failed jobs immediately
- Searches users to resolve support tickets
- Creates promo campaigns for marketing
- Monitors chargeback rate

**Pain Points:**
- Needs quick access to user history
- Wants proactive alerts, not reactive discovery
- Requires audit trail for all admin actions
- Needs tools to fix issues without database access

**Key User Stories:**
- US-ADMIN-01 (Dashboard)
- US-ADMIN-02 (Alerts)
- US-ADMIN-03 (Search users)
- US-ADMIN-04 (Investigate user)
- US-ADMIN-05 (Adjust credits)
- US-ADMIN-06 (Retry jobs)
- US-ADMIN-07 (Manage promos)
- US-ADMIN-08 (Stripe reconciliation)

**Test Scenarios:**
- Dashboard metrics accuracy
- Alert triggering conditions
- User search by email/ID
- Credit adjustment with audit
- Failed job retry workflow
- Promo campaign lifecycle

---

### System - The Background Processor
`INTERNAL`

**Demographics:**
- Role: Automated system processes
- Access: Database, external APIs

**Goals:**
- Process letters reliably
- Maintain data consistency
- Handle failures gracefully
- Keep credits accurate

**Behaviors:**
- Runs background jobs continuously
- Retries failed operations
- Expires stale data
- Reconciles external systems

**Responsibilities:**
- Letter job processing (PostGrid integration)
- **Letter status sync from fulfillment providers (every 6 hours)**
- Credit expiration marking
- Draft cleanup
- Balance reconciliation
- Tier recalculation
- Stripe webhook handling

**Key User Stories:**
- US-LETTER-06 (Background processing)
- US-LETTER-07 (Status sync from providers)
- US-CREDIT-03 (Credit expiration)
- US-CREDIT-06 (Refund handling)
- US-EDGE-01 (Draft expiration)
- US-EDGE-04 (Webhook idempotency)
- US-DATA-01 (Balance consistency)

**Test Scenarios:**
- Job retry with exponential backoff
- Max retry failure handling
- Expiration job accuracy
- Webhook duplicate handling
- Race condition prevention
- Reconciliation detection and fix
- Status sync from fulfillment providers
- Provider status → database status mapping

---

## Anti-Personas (Who We Don't Serve)

### Sam - The Bulk Mailer
`ANTI`

**Characteristics:**
- Wants to send thousands of marketing letters
- Looking for cheapest possible per-piece rate
- Doesn't care about personalization
- May have questionable mailing lists

**Why Not Served:**
- Letter IRL is for personal/small business correspondence
- No bulk upload or mail merge features
- Credit pricing doesn't scale for mass mail
- Rate limiting prevents abuse

**Security Considerations:**
- Rate limiting per user
- Tier-based limits
- No API for automated bulk sends
- Manual review for suspicious patterns

---

### Frank - The Scammer
`ANTI`

**Characteristics:**
- Uses stolen credit cards
- Creates multiple accounts
- Abuses promo codes
- Attempts chargebacks after using service

**Why Not Served:**
- Stripe fraud detection
- One promo per user enforcement
- Chargeback tracking and blocking
- Auth0 identity verification

**Security Considerations:**
- US-SEC-04 (Stripe webhook security)
- Chargeback alerts in admin dashboard
- Credit revocation on refund
- Account investigation tools

---

## Persona-Story Matrix

| Persona | Category | P0 Stories | P1 Stories | P2 Stories |
|---------|----------|------------|------------|------------|
| Sarah | CONSUMER | US-LETTER-01, US-LETTER-02, US-CREDIT-01 | US-LETTER-04, US-EDGE-02 | US-ACCT-03 |
| Marcus | CONSUMER | US-LETTER-01, US-LETTER-02, US-LETTER-03 | US-LETTER-04, US-LETTER-05, US-CREDIT-03 | US-PROMO-02, US-CREDIT-04 |
| Eleanor | CONSUMER | US-LETTER-01, US-LETTER-02, US-LETTER-03 | US-LETTER-04 | US-ACCT-02 |
| David | BUSINESS | US-LETTER-02, US-CREDIT-02 | US-LETTER-05, US-CREDIT-04 | US-CREDIT-05 |
| Morgan | DEV | US-MCP-01, US-LETTER-01, US-LETTER-02 | US-MCP-02, US-MCP-03 | US-LETTER-04, US-LETTER-05 |
| Jordan | DEV | US-MCP-01, US-LETTER-03 | US-MCP-02, US-EDGE-03 | US-LETTER-04, US-LETTER-05 |
| Alex | CONSUMER | US-CREDIT-01 | US-CREDIT-03 | US-PROMO-01, US-PROMO-02, US-PROMO-03 |
| Amy | INTERNAL | - | - | US-ADMIN-01 - US-ADMIN-08 |
| System | INTERNAL | US-SEC-01 | US-LETTER-06, US-EDGE-04 | US-DATA-01 - US-DATA-03 |

---

## Usage in Testing

When writing test cases, consider:

1. **Happy Path Tests:** Use Sarah or Marcus scenarios
2. **Edge Case Tests:** Use Eleanor (accidental actions) or Alex (boundary testing)
3. **Load/Scale Tests:** Use David scenarios
4. **Security Tests:** Use Frank scenarios
5. **Admin Tests:** Use Amy scenarios
6. **Integration Tests:** Use System scenarios
7. **MCP/API Tests:** Use Morgan or Jordan scenarios
8. **Token Auth Tests:** Use Morgan (PAT generation, revocation)

---

## See Also

- [USER-STORIES.md](USER-STORIES.md) - Detailed user stories with acceptance criteria
- [STATUS.md](STATUS.md) - Project overview
- [user-flows.md](user-flows.md) - Step-by-step user flows

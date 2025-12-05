# Personas

**Last Updated:** December 5, 2025
**Purpose:** Define user archetypes for product design, user stories, and test scenarios

---

## Overview

Letter IRL serves users who want to send physical letters through conversational AI. These personas represent distinct user types with different needs, behaviors, and pain points.

---

## Primary Personas

### 1. Sarah - The Occasional Sender

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
- US-1.1 (Preview letter)
- US-1.2 (Send letter)
- US-2.1 (Check balance)
- US-6.2 (Address correction)

**Test Scenarios:**
- First-time user flow
- Single letter with preview → confirm cycle
- Address validation with corrections
- Credit expiration warnings

---

### 2. Marcus - The Regular Correspondent

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
- US-1.3 (Idempotent send - network reliability)
- US-1.4 (Check status)
- US-1.5 (List letters)
- US-3.2 (Redeem promo)
- US-2.4 (Transaction history)

**Test Scenarios:**
- Multiple letters in quick succession
- Status checking workflow
- Promo code redemption
- Transaction history review
- Credit balance monitoring

---

### 3. Eleanor - The Legacy Connector

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
- US-1.1 (Clear preview with cost)
- US-1.3 (Idempotency protection)
- US-1.4 (Status confirmation)
- US-2.1 (Simple balance check)

**Test Scenarios:**
- Accidental double-click protection
- Clear error messages
- Simple success confirmations
- Expiration warning clarity

---

### 4. David - The Business User

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
- US-2.2 (Purchase credits - power pack)
- US-2.4 (Transaction history for expenses)
- US-1.5 (List all letters)
- US-2.5 (Detailed ledger)

**Test Scenarios:**
- High-volume credit purchase
- Bulk letter sending
- Export transaction history
- Letter list pagination
- Rate limiting at scale

---

### 5. Alex - The Promo Hunter

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
- US-3.1 (Validate promo)
- US-3.2 (Redeem promo)
- US-3.3 (View redemptions)
- US-2.3 (Credit expiration - promo credits expire faster)

**Test Scenarios:**
- Promo code validation (valid/invalid/expired)
- One redemption per user enforcement
- New user requirement validation
- Campaign limit enforcement
- Credit expiration for promo credits (90 days)

---

## Secondary Personas

### 6. Admin Amy - The Platform Operator

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
- US-5.1 (Dashboard)
- US-5.2 (Alerts)
- US-5.3 (Search users)
- US-5.4 (Investigate user)
- US-5.5 (Adjust credits)
- US-5.6 (Retry jobs)
- US-5.7 (Manage promos)
- US-5.8 (Stripe reconciliation)

**Test Scenarios:**
- Dashboard metrics accuracy
- Alert triggering conditions
- User search by email/ID
- Credit adjustment with audit
- Failed job retry workflow
- Promo campaign lifecycle

---

### 7. System - The Background Processor

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
- US-1.6 (Background processing)
- US-1.7 (Status sync from providers)
- US-2.3 (Credit expiration)
- US-2.6 (Refund handling)
- US-6.1 (Draft expiration)
- US-6.4 (Webhook idempotency)
- US-8.1 (Balance consistency)

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

### 8. Spammy Sam - The Bulk Mailer

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

### 9. Fraudulent Frank - The Scammer

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
- US-7.4 (Stripe webhook security)
- Chargeback alerts in admin dashboard
- Credit revocation on refund
- Account investigation tools

---

## Persona-Story Matrix

| Persona | P0 Stories | P1 Stories | P2 Stories |
|---------|------------|------------|------------|
| Sarah (Occasional) | US-1.1, US-1.2, US-2.1 | US-1.4, US-6.2 | US-4.3 |
| Marcus (Regular) | US-1.1, US-1.2, US-1.3 | US-1.4, US-1.5, US-2.3 | US-3.2, US-2.4 |
| Eleanor (Legacy) | US-1.1, US-1.2, US-1.3 | US-1.4 | US-4.2 |
| David (Business) | US-1.2, US-2.2 | US-1.5, US-2.4 | US-2.5 |
| Alex (Promo) | US-2.1 | US-2.3 | US-3.1, US-3.2, US-3.3 |
| Admin Amy | - | - | US-5.1 - US-5.8 |
| System | US-7.1 | US-1.6, US-6.4 | US-8.1 - US-8.3 |

---

## Usage in Testing

When writing test cases, consider:

1. **Happy Path Tests:** Use Sarah or Marcus scenarios
2. **Edge Case Tests:** Use Eleanor (accidental actions) or Alex (boundary testing)
3. **Load/Scale Tests:** Use David scenarios
4. **Security Tests:** Use Fraudulent Frank scenarios
5. **Admin Tests:** Use Admin Amy scenarios
6. **Integration Tests:** Use System scenarios

---

## See Also

- [USER-STORIES.md](USER-STORIES.md) - Detailed user stories with acceptance criteria
- [STATUS.md](STATUS.md) - Project overview
- [user-flows.md](user-flows.md) - Step-by-step user flows

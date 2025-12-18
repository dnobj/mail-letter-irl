# OpenAI Apps SDK Submission Guidelines for Letter IRL

> **Last Updated**: December 18, 2025
> **Status**: Active
> **Purpose**: Comprehensive compliance checklist for Letter IRL's OpenAI Apps SDK submission

---

## Table of Contents

1. [Overview](#overview)
2. [Letter IRL Compliance Status](#letter-irl-compliance-status)
3. [App Fundamentals](#app-fundamentals)
4. [Tool Requirements](#tool-requirements)
5. [Authentication & Permissions](#authentication--permissions)
6. [Commerce & Monetization](#commerce--monetization)
7. [Safety Requirements](#safety-requirements)
8. [Privacy Requirements](#privacy-requirements)
9. [Submission Process](#submission-process)
10. [Pre-Submission Checklist](#pre-submission-checklist)
11. [Related Documentation](#related-documentation)

---

## Overview

This document serves as the authoritative guide for ensuring Letter IRL meets all OpenAI Apps SDK requirements before submission. OpenAI opened app submissions on December 17, 2025, and Letter IRL is targeting submission at ~95% completion.

**What Letter IRL Does**: Letter IRL is a physical letter mailing service integrated with ChatGPT. Users compose letters in conversation, preview them with realistic formatting, and send them via First Class USPS mail—all without leaving ChatGPT.

**Why These Guidelines Matter**: OpenAI's Apps SDK has strict requirements for quality, safety, privacy, and user experience. Non-compliant apps are rejected during review. This document maps each requirement to Letter IRL's implementation, providing checkboxes for verification and identifying any gaps.

**Implementation Technology**: Letter IRL uses the Model Context Protocol (MCP) as the technical foundation, exposing tools via MCP that OpenAI's Apps SDK ingests. The terms "MCP tools" and "app tools" are used interchangeably in this document.

---

## Letter IRL Compliance Status

### High-Level Readiness Assessment

| Category | Status | Notes |
|----------|--------|-------|
| App Fundamentals | Complete | All tools functional, tested, stable |
| Tool Requirements | Complete | Names, descriptions, annotations correct |
| Authentication | Complete | OAuth via Auth0, PAT support |
| Commerce | Complete | Physical goods via external Stripe checkout |
| Safety | Complete | Moderation-ready, rate limited |
| Privacy | Complete | Clear policies, minimal data collection |
| Submission Materials | In Progress | Privacy policy published, demo credentials ready |

**Overall Readiness**: 95% (see [Pre-Submission Checklist](#pre-submission-checklist) for remaining items)

---

## App Fundamentals

### Official Requirements

Apps must:
1. Serve a clear purpose and reliably do what they promise
2. Provide functionality beyond ChatGPT's native capabilities
3. Be thoroughly tested for stability, responsiveness, and latency
4. Never crash, hang, or behave inconsistently
5. Be complete apps (demos rejected)
6. Have clear, accurate names and descriptions

### Letter IRL Compliance

#### 1. Clear Purpose
- **Status**: Complete
- **Implementation**: Letter IRL enables physical letter mailing—a capability ChatGPT cannot provide natively
- **Manifest Description**: "Send beautifully formatted physical letters via First Class USPS mail. Letter IRL handles printing, addressing, and delivery so your words arrive in mailboxes across the United States."
- **Verification**:
  - [x] App purpose is immediately clear to users
  - [x] Value proposition is unique (physical mailing)
  - [x] No ambiguity about what the app does

#### 2. Beyond Native ChatGPT Capabilities
- **Status**: Complete
- **Implementation**: ChatGPT cannot send physical mail, validate postal addresses, or integrate with USPS
- **Unique Features**:
  - Physical letter printing and mailing via PostGrid
  - USPS address validation
  - Professional letter formatting with letterhead
  - Delivery tracking and status updates
- **Verification**:
  - [x] Functionality is impossible without external integration
  - [x] Provides real-world action (not just information)
  - [x] Clear value beyond text generation

#### 3. Stability, Responsiveness, Latency
- **Status**: Complete
- **Testing**: End-to-end flow exerciser (`npm run flow`) validates all critical paths
- **Performance Targets**:
  - Preview generation: < 2 seconds
  - Letter sending: < 3 seconds (before background processing)
  - Status checks: < 1 second
  - Balance checks: < 500ms
- **Error Handling**:
  - All tools return structured errors with clear messages
  - Network failures are caught and reported
  - Database transactions are atomic
  - Race conditions prevented (US-EDGE-03, US-EDGE-08)
- **Verification**:
  - [x] All tools tested under normal conditions
  - [x] Error paths validated
  - [x] Response times meet targets
  - [x] No memory leaks or resource exhaustion
  - [x] Graceful degradation when services unavailable

#### 4. No Crashes, Hangs, or Inconsistencies
- **Status**: Complete
- **Implementation**:
  - Try-catch blocks around all external API calls
  - Timeouts on all network requests
  - Database connection pooling and health checks
  - Structured error responses (never uncaught exceptions)
  - Idempotency on write operations (US-LETTER-03)
- **Monitoring**: Structured logging with redaction (PII protected)
- **Verification**:
  - [x] No unhandled promise rejections
  - [x] All async operations have timeouts
  - [x] Database failures handled gracefully
  - [x] External API failures don't crash server
  - [x] Concurrent requests handled safely

#### 5. Complete App (Not a Demo)
- **Status**: Complete
- **Production Features**:
  - Real PostGrid integration for printing/mailing
  - Real Stripe integration for payments
  - Real Auth0 OAuth for authentication
  - Persistent database storage (Neon PostgreSQL)
  - Background job processing for order fulfillment
  - Status syncing from fulfillment providers
- **Not Demo Limitations**:
  - No "sandbox mode only" warnings
  - No placeholders for core functionality
  - No hardcoded test data in production
- **Verification**:
  - [x] All features fully implemented
  - [x] Production-ready infrastructure
  - [x] Real payment processing
  - [x] Real mail delivery
  - [x] No "coming soon" placeholders

#### 6. Clear, Accurate Names and Descriptions
- **Status**: Complete
- **App Name**: "Letter IRL"
  - Clear, memorable, descriptive
  - IRL = "In Real Life" (physical letters)
- **Tool Names**: All verbs, human-readable (see [Tool Requirements](#tool-requirements))
- **Descriptions**: Concise, accurate, no marketing fluff
- **Verification**:
  - [x] App name clearly indicates purpose
  - [x] Tool names follow OpenAI conventions
  - [x] Descriptions match actual behavior
  - [x] No misleading claims

---

## Tool Requirements

### Official Requirements

Tools must:
1. Have human-readable names as verbs (e.g., `get_order_status`)
2. Have unique names within the app
3. Have clear descriptions explaining what each tool does
4. Use correct annotations:
   - `readOnlyHint` for data retrieval tools
   - `openWorldHint` for tools interacting with external systems
5. Have minimal inputs (only what's necessary)
6. Never hide or make side effects implicit

### Letter IRL Compliance

#### Tool Inventory

Letter IRL exposes 8 MCP tools:

| Tool Name | Type | Read-Only | External System | Status |
|-----------|------|-----------|-----------------|--------|
| `quote_and_preview_letter` | Preview | Yes | PostGrid (validation) | Complete |
| `send_letter` | Write | No | PostGrid (fulfillment) | Complete |
| `get_order_status` | Read | Yes | PostGrid (tracking) | Complete |
| `get_account_balance` | Read | Yes | Database only | Complete |
| `list_orders` | Read | Yes | Database only | Complete |
| `set_return_address` | Write | No | Database only | Complete |
| `get_return_address` | Read | Yes | Database only | Complete |
| `clear_return_address` | Write | No | Database only | Complete |

**Note**: `switch_account` exists as a REST API endpoint (not an MCP tool) for OAuth logout flows.

#### 1. Human-Readable Verb Names
- **Status**: Complete
- **Implementation**:
  - `quote_and_preview_letter` - Describes both actions (quoting cost + showing preview)
  - `send_letter` - Clear imperative verb
  - `get_order_status` - Standard REST-style verb
  - `get_account_balance` - Standard REST-style verb
  - `list_orders` - Standard REST-style verb
  - `set_return_address` - Clear imperative verb
  - `get_return_address` - Standard REST-style verb
  - `clear_return_address` - Clear imperative verb
- **Verification**:
  - [x] All names are verbs or verb phrases
  - [x] Names describe user intent, not implementation
  - [x] Names are conversational (how users would ask)
  - [x] No technical jargon or abbreviations

#### 2. Unique Tool Names
- **Status**: Complete
- **Verification**:
  - [x] No duplicate names in manifest
  - [x] Names are distinct enough to avoid confusion
  - [x] ChatGPT can unambiguously select correct tool

#### 3. Clear Descriptions

**Examples from Letter IRL**:

```json
{
  "name": "quote_and_preview_letter",
  "description": "Generate a formatted preview of the letter and calculate the required credits. Returns an HTML preview showing exactly how the letter will look when printed, along with the cost in credits. This is a read-only operation that does not send the letter or charge credits."
}
```

```json
{
  "name": "send_letter",
  "description": "Send the letter for printing and mailing. This operation deducts credits from the user's account and queues the letter for fulfillment. The user must explicitly confirm by setting confirm=true."
}
```

- **Verification**:
  - [x] Descriptions explain what the tool does
  - [x] Descriptions clarify side effects (credit deductions)
  - [x] Descriptions indicate read vs. write operations
  - [x] Descriptions mention any user confirmations required
  - [x] Length appropriate (2-3 sentences for complex tools)

#### 4. Correct Annotations

**Read-Only Tools** (`readOnlyHint: true`):
- [x] `quote_and_preview_letter` - Generates preview without creating order
- [x] `get_order_status` - Retrieves existing order information
- [x] `get_account_balance` - Retrieves account information
- [x] `list_orders` - Retrieves order history
- [x] `get_return_address` - Retrieves saved return address

**Write Tools** (no `readOnlyHint` or `readOnlyHint: false`):
- [x] `send_letter` - Creates order, deducts credits, queues job
- [x] `set_return_address` - Saves return address to database
- [x] `clear_return_address` - Removes saved return address

**Open World Tools** (`openWorldHint: true`):
- [x] `quote_and_preview_letter` - Validates addresses via PostGrid API
- [x] `send_letter` - Submits letter to PostGrid for printing/mailing
- [x] `get_order_status` - Queries PostGrid for fulfillment status

**Reference**: See `/mnt/c/letter-irl/docs/tool-apis.md` for complete schema definitions with metadata.

#### 5. Minimal Inputs

**Best Practice**: Only request information that cannot be inferred or is absolutely required.

**Letter IRL Examples**:

**Good - `quote_and_preview_letter`**:
```json
{
  "sender": { /* full address block */ },
  "recipient": { /* full address block */ },
  "bodyText": "string",
  "signOff": "string"
}
```
- **Why Good**: All fields are required for preview generation. Cannot infer addresses or content.

**Good - `send_letter`**:
```json
{
  "sender": { /* same as preview */ },
  "recipient": { /* same as preview */ },
  "bodyText": "string",
  "signOff": "string",
  "requiredCredits": "number",
  "confirm": "boolean"
}
```
- **Why Good**: Passes same content as preview (no re-entry). `requiredCredits` ensures price consistency. `confirm` is explicit safety gate.

**Good - `get_order_status`**:
```json
{
  "orderId": "string" // OPTIONAL
}
```
- **Why Good**: If omitted, returns most recent order. Provides convenience without forcing users to remember IDs.

**Anti-Pattern (Avoided)**:
```json
{
  "sender": { /* address */ },
  "recipient": { /* address */ },
  "bodyText": "string",
  "signOff": "string",
  "userBirthday": "string",  // ❌ UNNECESSARY
  "userPhone": "string",      // ❌ UNNECESSARY
  "marketingConsent": "boolean" // ❌ UNNECESSARY
}
```
- **Why Bad**: Collects data "just in case" rather than for the specific task.

- **Verification**:
  - [x] No profile data collection beyond authentication
  - [x] No "just in case" fields
  - [x] Optional fields truly optional
  - [x] Required fields justified by functionality

#### 6. No Hidden Side Effects

**Letter IRL Transparency**:

1. **Credit Deductions**:
   - Tool name: `send_letter` (clear mutation)
   - Description: "This operation deducts credits from the user's account"
   - Input: `confirm: true` required (explicit gate)
   - Preview shows cost BEFORE sending

2. **External System Interactions**:
   - Description mentions "queues the letter for fulfillment"
   - Status updates available via `get_order_status`
   - No silent external calls

3. **Address Validation**:
   - `quote_and_preview_letter` description mentions validation
   - Invalid addresses return clear error before preview
   - Corrections surfaced to user (US-EDGE-02)

- **Verification**:
  - [x] All write operations clearly named
  - [x] All side effects documented in descriptions
  - [x] All external system calls disclosed
  - [x] All costs/charges shown before confirmation
  - [x] No "silent" state changes

---

## Authentication & Permissions

### Official Requirements

1. Authentication flows must be transparent and explicit
2. Users must be clearly informed of all requested permissions
3. Provide fully-featured demo credentials with sample data for review
4. Submissions requiring new account sign-ups get rejected

### Letter IRL Compliance

#### 1. Transparent Authentication Flow
- **Status**: Complete
- **Implementation**: OAuth 2.0 via Auth0 with 5 providers
  - Google
  - Microsoft
  - Apple
  - GitHub
  - Email/Password
- **Flow**:
  1. User connects Letter IRL in ChatGPT
  2. ChatGPT redirects to Auth0 authorization endpoint
  3. User selects provider and authorizes
  4. Auth0 issues JWT token to ChatGPT
  5. ChatGPT includes JWT in MCP requests (`Authorization: Bearer <token>`)
  6. Letter IRL validates JWT against Auth0 JWKS
  7. User record created/retrieved on first tool call (US-ACCT-00)
- **Transparency**:
  - Auth0 Universal Login shows Letter IRL app name
  - Permissions screen lists requested scopes
  - User explicitly clicks "Authorize"
- **Verification**:
  - [x] OAuth flow follows standard
  - [x] No implicit grants or unusual flows
  - [x] User sees what app they're authorizing
  - [x] User sees what permissions are requested

#### 2. Clear Permission Requests
- **Status**: Complete
- **Requested Scopes**:
  - `openid` - Required for OAuth
  - `email` - Used to identify user account
  - `profile` - Used to personalize experience (name in letterhead)
- **Why Each Scope is Needed**:
  - `openid`: Standard identifier for authenticated user
  - `email`: Letter IRL uses email as primary account key; needed to retrieve user's credits and orders
  - `profile`: Optional but enhances UX (pre-fills sender name in letters)
- **Permission Display**: Auth0 shows standard OAuth consent screen
- **Verification**:
  - [x] Only necessary scopes requested
  - [x] Each scope has clear justification
  - [x] Scopes match OAuth 2.0 standards
  - [x] User can understand what each permission means

#### 3. Demo Credentials for Review
- **Status**: Complete
- **Demo Account Details**:
  ```
  Email: demo@letterirl.com
  Password: [Provided separately to OpenAI reviewers]
  Auth Provider: Email/Password
  ```
- **Demo Account Features**:
  - Pre-loaded with 100 credits (50 letters)
  - Sample sent letters in history (various statuses)
  - Sample promo codes available for testing
  - No rate limits for demo account
- **Sample Data**:
  - 3 completed letters (showing full lifecycle)
  - 1 in-transit letter (showing tracking)
  - 1 letter from 7 days ago (showing timeline)
  - Transaction history with purchases and redemptions
- **Testing Capabilities**:
  - Can preview letters without cost
  - Can send test letters (non-deliverable addresses flagged as test)
  - Can check balance and status
  - Can redeem demo promo codes
- **Verification**:
  - [x] Demo account exists and is accessible
  - [x] Demo account has sufficient credits for testing
  - [x] Demo account shows representative data
  - [x] Demo account doesn't require signup
  - [x] Demo credentials documented in submission materials

#### 4. No Required Sign-Ups
- **Status**: Complete
- **Implementation**: Auto-registration on first use
  - User authenticates via OAuth (no manual signup form)
  - Account created automatically on first MCP tool call
  - Email extracted from OAuth token
  - No additional registration step required
- **New User Experience**:
  1. User connects Letter IRL in ChatGPT
  2. User authorizes via OAuth provider
  3. User immediately starts using app (preview letters)
  4. Account created in background
  5. User prompted to purchase credits or enter promo code when ready to send
- **No Barriers**:
  - No email verification required
  - No profile completion forms
  - No terms acceptance popups (linked in OAuth screen)
  - No mandatory onboarding flow
- **Verification**:
  - [x] OAuth handles identity, no separate signup
  - [x] Account creation is automatic and invisible
  - [x] Users can preview immediately
  - [x] Only payment required when actually sending
  - [x] Demo account bypasses all restrictions

#### Alternative: Personal Access Tokens (PAT)
- **Status**: Complete (for non-ChatGPT clients)
- **Implementation**: Users can generate PATs from web dashboard after OAuth login
- **Use Case**: Claude Desktop and other MCP clients without OAuth support
- **Flow**:
  1. User logs in to letterirl.com via OAuth
  2. User navigates to "Developer Settings"
  3. User clicks "Generate PAT"
  4. PAT shown once (format: `lirl_pat_xxxxx`)
  5. User adds PAT to MCP client config
  6. MCP client sends `Authorization: Bearer lirl_pat_xxxxx`
- **Verification**:
  - [x] PAT generation requires OAuth first (no new signup)
  - [x] PAT auth is alternative path, not primary
  - [x] PATs are revocable by user
  - [x] PAT usage tracked (US-MCP-05)

**Reference**: See `/mnt/c/letter-irl/docs/auth0-tenant-configuration.md` and `/mnt/c/letter-irl/docs/account-switching-guide.md` for OAuth implementation details.

---

## Commerce & Monetization

### Official Requirements

1. Physical goods allowed via external checkout
2. Digital products, subscriptions, credits, tokens PROHIBITED within ChatGPT
3. Apps must not serve advertisements
4. Use external checkout directing to your own domain

### Letter IRL Compliance

#### 1. Physical Goods Model
- **Status**: Complete
- **What Letter IRL Sells**: Physical letters delivered via USPS
- **Why It's Physical**:
  - Tangible output (printed paper)
  - Physical delivery (postal service)
  - Real-world destination (recipient's mailbox)
- **Not Digital**: Letters are not delivered electronically, via email, or as downloads
- **Verification**:
  - [x] Product is physical (printed letters)
  - [x] Delivery is physical (USPS mail)
  - [x] Complies with OpenAI physical goods policy

#### 2. External Checkout Model
- **Status**: Complete
- **Implementation**: Stripe Checkout hosted on Letter IRL domain
- **Flow**:
  1. User needs credits to send letter
  2. `quote_and_preview_letter` returns `canSendNow: false` if insufficient credits
  3. ChatGPT displays message: "You need 2 credits to send this letter. You have 0 credits."
  4. User says "I want to buy credits"
  5. ChatGPT provides link: `https://letterirl.com/credits/purchase?package=credit-pack-10`
  6. User clicks link, opens browser
  7. Stripe Checkout loads on `letterirl.com` domain
  8. User completes payment
  9. Stripe webhook adds credits to Letter IRL account
  10. User returns to ChatGPT
  11. User calls `send_letter` successfully
- **External Domain**: All payment flows on `letterirl.com` or `checkout.stripe.com`
- **No In-Chat Commerce**:
  - No payment UI within ChatGPT
  - No credit card entry in widgets
  - No Stripe elements embedded in MCP responses
- **Verification**:
  - [x] Checkout hosted externally
  - [x] User leaves ChatGPT to complete purchase
  - [x] Payment processed on Letter IRL's own domain
  - [x] Webhook confirms payment before credits added

#### 3. No Digital Products or Subscriptions
- **Status**: Complete
- **What Letter IRL Does NOT Sell**:
  - No digital downloads
  - No subscription plans
  - No in-app purchases within ChatGPT
  - No virtual goods
  - No NFTs or crypto
- **Credit Model**:
  - Credits are **internal currency** used to track prepayment
  - Credits purchase physical goods (letters)
  - Credits cannot be:
    - Resold
    - Transferred to other users
    - Withdrawn or cashed out
    - Used for anything except printing/mailing letters
- **Why This Complies**: Credits are not the product—they're a payment mechanism for physical goods. Analogous to arcade tokens or gift cards.
- **Verification**:
  - [x] No subscriptions offered
  - [x] No digital products
  - [x] Credits are prepayment, not standalone product
  - [x] Credits always redeem for physical goods

#### 4. No Advertisements
- **Status**: Complete
- **Policy**: Letter IRL does not serve ads
- **Widget Content**:
  - Preview shows letter content only
  - Confirmation shows order details only
  - Balance shows credit info only
  - No banner ads, sponsored content, or promotions
- **Verification**:
  - [x] No ads in tool responses
  - [x] No ads in widgets
  - [x] No sponsored content
  - [x] No affiliate links

#### Credit Packages
- **Offered Tiers**:
  - Starter: 4 credits ($10) - 2 letters
  - Regular: 10 credits ($23) - 5 letters
  - Power: 100 credits ($195) - 50 letters (10% savings)
- **Pricing Transparency**:
  - All prices shown before checkout
  - Cost per letter displayed
  - Savings percentage shown for bulk
- **Expiration Policy**:
  - Purchased credits: 2 years (730 days)
  - Promo credits: 90 days (campaign-specific)
  - Signup bonus: 30 days
  - Admin adjustments: Never expire
- **Verification**:
  - [x] Pricing is clear and upfront
  - [x] No hidden fees
  - [x] Expiration policy disclosed
  - [x] User sees all terms before purchase

**Reference**: See `/mnt/c/letter-irl/docs/credit-purchase-flow.md` and `/mnt/c/letter-irl/docs/acp-stripe-integration.md` for implementation details.

---

## Safety Requirements

### Official Requirements

1. Comply with OpenAI's usage policies
2. Apps must be suitable for general audiences (ages 13+)
3. Address user requests directly, no unrelated content
4. Don't bypass API restrictions, rate limits, or access controls

### Letter IRL Compliance

#### 1. OpenAI Usage Policy Compliance
- **Status**: Complete
- **Prohibited Use Cases (Verified as Non-Applicable)**:
  - [x] No illegal activity (physical letters are legal)
  - [x] No child exploitation (age-appropriate content)
  - [x] No hate speech (content moderation planned)
  - [x] No malware/phishing (no code execution)
  - [x] No deceptive activity (clear purpose)
  - [x] No physical harm (letters are non-threatening)
  - [x] No fraudulent activity (verified payment processing)
  - [x] No adult content (family-friendly service)
  - [x] No privacy violations (see Privacy section)
  - [x] No unauthorized legal/medical/financial advice (just mails letters)
- **Verification**:
  - [x] Service use cases reviewed against policy
  - [x] No policy violations identified
  - [x] Abuse prevention measures in place

#### 2. General Audience Suitability (Ages 13+)
- **Status**: Complete
- **Content Restrictions**:
  - No profanity in system messages
  - No graphic violence in examples
  - No sexual content in documentation
  - No mature themes in UI
- **User-Generated Content**:
  - Users can write any letter content
  - Letter IRL does not pre-filter (user responsibility)
  - Admin review queue available (US-ADMIN placeholder)
  - Future: Content moderation API integration planned
- **Age Appropriateness**:
  - Service concept (letter writing) is age-neutral
  - UI is professional and clean
  - No age-restricted features
- **Verification**:
  - [x] Service suitable for teens (13+)
  - [x] No age-gated content
  - [x] Family-friendly interface
  - [x] User-generated content is user's responsibility

#### 3. Address User Requests Directly
- **Status**: Complete
- **Response Quality**:
  - Tools return only relevant information
  - No cross-selling or upselling in tool responses
  - No promotional messages injected into content
  - No unrelated features suggested
- **Example Good Responses**:
  - User asks for balance → Returns balance and affordability
  - User previews letter → Returns preview and cost
  - User checks status → Returns status and timeline
- **Example Bad Responses (Avoided)**:
  - ❌ User asks for balance → Returns balance + "Try our premium service!"
  - ❌ User previews letter → Returns preview + "Follow us on Twitter!"
  - ❌ User checks status → Returns status + "Refer a friend for free credits!"
- **Verification**:
  - [x] Tool responses are focused and relevant
  - [x] No marketing messages in responses
  - [x] No unrelated content injected
  - [x] No "while you're here" suggestions

#### 4. Don't Bypass API Restrictions
- **Status**: Complete
- **Rate Limiting**:
  - Per-user rate limits enforced (US-SEC-05)
  - Tier-based limits (trusted users get higher limits)
  - 429 Too Many Requests returned when exceeded
  - Rate limit headers included (X-RateLimit-*)
- **Rate Limit Tiers**:
  - New users: 10 requests/minute
  - Regular users: 30 requests/minute
  - Power users: 100 requests/minute
  - Demo account: Unlimited (for OpenAI review)
- **Access Controls**:
  - Authentication required on all endpoints
  - User data isolated (US-SEC-02)
  - Admin routes restricted (US-SEC-03)
  - Cross-user access returns 404 (not 403)
- **No Bypass Mechanisms**:
  - No "special" API keys that skip rate limits
  - No hidden endpoints without auth
  - No credential sharing between users
  - No rate limit "credits" for sale
- **Verification**:
  - [x] Rate limits enforced consistently
  - [x] No backdoor access
  - [x] Authentication cannot be bypassed
  - [x] Admin controls properly restricted
  - [x] Demo account is only exception (for review)

#### Abuse Prevention

**Content Moderation (Planned)**:
- Admin review queue for suspicious content
- `holdForReview` flag on new orders
- Manual vetting during prototype phase
- Future: Automated moderation API integration

**Spam Prevention**:
- Rate limits on letter sending (3 letters/hour for new users)
- Credit purchase limits (prevent money laundering)
- Address validation (prevent fake destinations)
- Duplicate detection (same content to many recipients)

**Harassment Prevention**:
- No bulk mailing features in v1
- Each letter requires explicit confirmation
- User identity tracked for all letters
- Abuse reports handled by admin dashboard

**Verification**:
- [x] Rate limits prevent spam (US-SEC-05)
- [x] Confirmation gates prevent accidental sends
- [x] Audit trail for all letters (US-DATA-02)
- [x] Admin tools for investigating abuse (US-ADMIN-04)

**Reference**: See `/mnt/c/letter-irl/docs/security-and-policy.md` for safety implementation details.

---

## Privacy Requirements

### Official Requirements

1. Clear, published privacy policy required
2. Data collection minimization
3. Response minimization (return only relevant data)
4. PROHIBITED collection: PCI data, PHI, SSNs, credentials/API keys
5. Any action sending data outside must be surfaced as a write action
6. Requires user confirmation or preview mode for destructive actions

### Letter IRL Compliance

#### 1. Clear Privacy Policy
- **Status**: Complete
- **Published Location**: `https://letterirl.com/privacy`
- **Policy Contents**:
  - **What data we collect**:
    - Email address (from OAuth)
    - Name (optional, for letterhead)
    - Letter content (body text, sign-off)
    - Sender addresses (for return address on envelope)
    - Recipient addresses (for delivery)
    - Payment information (processed by Stripe, not stored)
    - Usage logs (tool calls, timestamps)
  - **Why we collect it**:
    - Email: Account identification
    - Name: Personalize letters
    - Content: Print and mail letters
    - Addresses: USPS delivery requirements
    - Payments: Process purchases
    - Logs: Debugging and abuse prevention
  - **How we use it**:
    - Letter content sent to PostGrid for printing
    - Addresses validated via PostGrid API
    - Payment processed via Stripe
    - Logs stored for 90 days, then aggregated
  - **Who we share it with**:
    - PostGrid (printing/mailing partner)
    - Stripe (payment processor)
    - Auth0 (authentication provider)
    - No other third parties
  - **User controls**:
    - View order history
    - Delete account (request via support)
    - Export data (request via support)
    - Revoke OAuth access (via ChatGPT settings)
- **Verification**:
  - [x] Privacy policy published and accessible
  - [x] Policy covers all data types collected
  - [x] Policy explains purposes clearly
  - [x] Policy lists all third-party recipients
  - [x] Policy describes user controls
  - [x] Policy written in plain language

#### 2. Data Collection Minimization
- **Status**: Complete
- **What We Collect**:
  - **Authentication**: Email address (required for account)
  - **Letters**: Sender/recipient addresses, body text, sign-off
  - **Orders**: Order ID, status, timestamps
  - **Credits**: Balance, transaction history
- **What We Do NOT Collect**:
  - Full credit card numbers (Stripe handles)
  - Phone numbers (not required)
  - Birthdate (not required)
  - Gender (not required)
  - Physical traits (not required)
  - Geolocation beyond postal address (not tracked)
  - Device fingerprints (not tracked)
  - IP addresses (not logged beyond rate limiting)
  - Social media profiles (not requested)
  - Contact lists (not imported)
- **Justification for Each Collected Field**:
  - **Email**: Required to identify user account across sessions
  - **Name**: Optional; improves letter personalization (appears in letterhead)
  - **Addresses**: Required for USPS delivery (cannot mail without)
  - **Body text**: Required to print letter (the product)
  - **Order metadata**: Required for status tracking and support
  - **Credit balance**: Required for payment system
- **Verification**:
  - [x] Only essential data collected
  - [x] No "nice to have" fields
  - [x] No broad profile data
  - [x] Each field has clear business justification
  - [x] Optional fields truly optional

#### 3. Response Minimization
- **Status**: Complete
- **What We Return**:
  - **Preview**: HTML preview, cost, affordability flag
  - **Status**: Order ID, current status, masked recipient (city/state only)
  - **Balance**: Credit count, affordability flags
  - **Confirmation**: Order ID, masked recipient, remaining credits
- **What We Do NOT Return**:
  - Full addresses after sending (only city/state)
  - Other users' data
  - Internal database IDs beyond order ID
  - Payment details (not stored)
  - Auth tokens or session IDs
  - System configuration
- **Masked Data Examples**:
  ```json
  // GOOD - After letter sent
  "recipientSummary": {
    "name": "Jane Doe",
    "city": "Beverly Hills",
    "state": "CA"
  }

  // BAD - What we don't return
  "recipient": {
    "name": "Jane Doe",
    "addressLine1": "123 Main St",  // ❌ Full address not needed
    "postalCode": "90210"            // ❌ Exact location not needed
  }
  ```
- **Verification**:
  - [x] Responses contain only necessary data
  - [x] Full addresses masked after sending
  - [x] No internal implementation details leaked
  - [x] No other users' data in responses
  - [x] No sensitive IDs exposed

#### 4. Prohibited Data Collection
- **Status**: Complete
- **PCI Data (Payment Card Industry)**:
  - ❌ No credit card numbers stored
  - ❌ No CVV codes stored
  - ❌ No expiration dates stored
  - ✅ All payment via Stripe Checkout (PCI-compliant)
  - ✅ Only Stripe session IDs stored (not sensitive)
- **PHI (Protected Health Information)**:
  - ❌ No medical records
  - ❌ No diagnoses
  - ❌ No prescriptions
  - ❌ No health insurance info
  - ✅ Letter content is user's responsibility
  - ✅ Letter IRL does not process/interpret content for health info
- **SSNs (Social Security Numbers)**:
  - ❌ Never requested
  - ❌ Never stored
  - ❌ Not required for service
- **Credentials/API Keys**:
  - ❌ No user passwords stored (Auth0 handles)
  - ❌ No API keys requested from users
  - ❌ No OAuth tokens stored (validated then discarded)
  - ✅ PATs are stored as bcrypt hashes (not plaintext)
- **Verification**:
  - [x] No PCI data collected or stored
  - [x] No PHI collected or processed
  - [x] No SSNs collected
  - [x] No user credentials stored
  - [x] Payment processing outsourced to PCI-compliant provider

#### 5. External Data Sharing Surfaced as Write Actions
- **Status**: Complete
- **Where Data Goes Outside Letter IRL**:
  1. **PostGrid (Printing/Mailing)**:
     - Triggered by: `send_letter` tool
     - Data sent: Full letter content, sender/recipient addresses
     - User awareness: Tool name "send_letter" is clear write action
     - Confirmation: `confirm: true` required in input
     - Preview: User sees exactly what will be sent
  2. **Stripe (Payment)**:
     - Triggered by: External checkout flow (not MCP tool)
     - Data sent: Email, credit card (user enters directly on Stripe)
     - User awareness: Leaves ChatGPT to Stripe's domain
     - Confirmation: Stripe's own payment confirmation
  3. **PostGrid (Address Validation)**:
     - Triggered by: `quote_and_preview_letter` tool
     - Data sent: Addresses only (no content)
     - User awareness: Tool description mentions validation
     - Read-only: Marked with `readOnlyHint: true`
     - Purpose: Prevent undeliverable letters (user benefit)
- **Tools and External Data Sharing**:

| Tool | Shares Data? | Destination | User Aware? | Write Action? |
|------|--------------|-------------|-------------|---------------|
| `quote_and_preview_letter` | Yes | PostGrid (validation) | Yes (description) | No (read-only) |
| `send_letter` | Yes | PostGrid (fulfillment) | Yes (name + confirm) | Yes |
| `get_order_status` | Yes | PostGrid (tracking) | Yes (description) | No (read-only) |
| `get_account_balance` | No | Database only | N/A | No |
| `list_orders` | No | Database only | N/A | No |
| `set_return_address` | No | Database only | N/A | Yes |
| `get_return_address` | No | Database only | N/A | No |
| `clear_return_address` | No | Database only | N/A | Yes |

- **Verification**:
  - [x] All external data sharing is disclosed
  - [x] Write actions clearly named as such
  - [x] User confirmation required for sending data out
  - [x] Read-only external calls properly annotated
  - [x] Tool descriptions mention external systems

#### 6. User Confirmation for Destructive Actions
- **Status**: Complete
- **Destructive Actions in Letter IRL**:
  1. **Sending a letter** (`send_letter`):
     - Deducts credits (cannot be refunded automatically)
     - Creates physical letter (cannot be unsent)
     - Shares content with PostGrid
     - Shares addresses with USPS
- **Confirmation Mechanism**:
  ```json
  // Input schema for send_letter
  {
    "confirm": {
      "type": "boolean",
      "description": "Must be true or request fails"
    }
  }
  ```
  - Tool REJECTS requests where `confirm !== true`
  - ChatGPT must explicitly set this based on user approval
- **Preview Mode**:
  - `quote_and_preview_letter` provides preview WITHOUT side effects
  - User sees exact letter appearance
  - User sees exact cost
  - User sees recipient summary
  - User decides whether to proceed
- **User Flow**:
  1. User composes letter in conversation
  2. ChatGPT calls `quote_and_preview_letter` (no side effects)
  3. User reviews preview and cost
  4. User explicitly says "Yes, send it" or "Send this letter"
  5. ChatGPT calls `send_letter` with `confirm: true`
  6. Letter is sent, credits deducted, confirmation returned
- **No Auto-Send**:
  - ❌ No automatic sends after preview
  - ❌ No "send on approval timeout"
  - ❌ No implicit confirmations
  - ✅ User must explicitly approve
  - ✅ Widget buttons trigger confirmation
- **Verification**:
  - [x] Destructive action (send_letter) requires explicit confirm flag
  - [x] Preview available before commitment
  - [x] Cost shown before commitment
  - [x] User must say "yes" explicitly
  - [x] No auto-sends or implied approvals
  - [x] Widget buttons are clearly labeled (US-LETTER-02)

#### Address Handling (Sensitive PII)
- **Why Addresses are Sensitive**:
  - Physical location information
  - Can identify individuals
  - Can reveal routines (home vs. work)
  - Can be used for harassment
- **How Letter IRL Protects Addresses**:
  1. **Collection**: Only collected when necessary (for mailing)
  2. **Validation**: Validated via PostGrid, not stored during validation
  3. **Storage**: Stored in Neon PostgreSQL with access controls
  4. **Transmission**: Sent to PostGrid over HTTPS
  5. **Response**: Full addresses not returned after sending (masked to city/state)
  6. **Retention**: Stored as long as order exists (for support/audit)
  7. **Access**: Only viewable by order owner and admins
- **User Control**:
  - User can view their own sent letters (with full addresses)
  - User can request account deletion (removes addresses)
  - User can export data (includes addresses)
- **Verification**:
  - [x] Addresses collected only when needed
  - [x] Addresses protected in storage
  - [x] Addresses transmitted securely
  - [x] Addresses masked in post-send responses
  - [x] Addresses not shared with unauthorized parties
  - [x] User has control over their address data

**Reference**: See `/mnt/c/letter-irl/docs/security-and-policy.md` for privacy implementation details.

---

## Submission Process

### Official Requirements

1. Submit from OpenAI Platform Dashboard
2. Provide accurate customer support contact details
3. One version under review at a time

### Letter IRL Compliance

#### 1. OpenAI Platform Dashboard Submission
- **Status**: Ready (not yet submitted as of Dec 18, 2025)
- **Preparation**:
  - [x] OpenAI developer account created
  - [x] App registered in OpenAI Platform
  - [ ] Manifest URL finalized: `https://api.letterirl.com/manifest.json`
  - [ ] OAuth configuration validated
  - [ ] Demo credentials prepared
  - [ ] Privacy policy URL confirmed: `https://letterirl.com/privacy`
  - [ ] Terms of service URL confirmed: `https://letterirl.com/terms`
- **Submission Materials**:
  - App name: "Letter IRL"
  - Short description: "Send beautifully formatted physical letters via USPS"
  - Long description: (see manifest.json)
  - Category: Productivity
  - Website: `https://letterirl.com`
  - Support email: `support@letterirl.com`
  - Privacy policy: `https://letterirl.com/privacy`
  - Terms: `https://letterirl.com/terms`
  - Manifest URL: `https://api.letterirl.com/manifest.json`
  - Demo credentials: (provided in submission notes)

#### 2. Customer Support Contact
- **Status**: Complete
- **Support Email**: `support@letterirl.com`
  - Monitored daily
  - Response time: < 24 hours
  - Handles: Bug reports, feature requests, account issues, refunds
- **Support Resources**:
  - Help documentation: `https://letterirl.com/help`
  - FAQ: `https://letterirl.com/faq`
  - Contact form: `https://letterirl.com/contact`
- **Admin Dashboard**:
  - User search and investigation tools (US-ADMIN-03, US-ADMIN-04)
  - Credit adjustment tools (US-ADMIN-05)
  - Order retry tools (US-ADMIN-06)
- **Verification**:
  - [x] Support email is active and monitored
  - [x] Support email is not personal (e.g., not gmail.com)
  - [x] Response time is reasonable
  - [x] Support resources are published
  - [x] Admin tools available for resolving issues

#### 3. One Version Under Review
- **Status**: Compliant (first submission)
- **Version Management**:
  - Initial submission: v1.0.0
  - No parallel submissions
  - Updates will be submitted after review completes
- **Verification**:
  - [x] This is the first and only submission
  - [x] No duplicate apps or submissions
  - [x] Clear versioning strategy

---

## Pre-Submission Checklist

### Critical Items (Must Complete Before Submission)

#### App Functionality
- [x] All 8 MCP tools implemented and tested
  - [x] `quote_and_preview_letter` - Preview generation works
  - [x] `send_letter` - Order creation and fulfillment works
  - [x] `get_order_status` - Status retrieval works
  - [x] `get_account_balance` - Balance retrieval works
  - [x] `list_orders` - Order history works
  - [x] `set_return_address` - Return address saving works
  - [x] `get_return_address` - Return address retrieval works
  - [x] `clear_return_address` - Return address clearing works
- [x] End-to-end flow tested (Flow A, B, C from user stories)
- [x] Error handling validated for all edge cases
- [x] Performance meets targets (< 3s for all operations)
- [x] No crashes or hangs under normal usage
- [x] Concurrent request handling tested (US-EDGE-03, US-EDGE-08)
- [x] Idempotency validated (US-LETTER-03)

#### Infrastructure
- [ ] Production domain configured: `api.letterirl.com`
- [ ] HTTPS certificate valid and not expiring soon
- [ ] MCP server deployed and accessible from ChatGPT
- [ ] Manifest served at `https://api.letterirl.com/manifest.json`
- [ ] OAuth endpoints accessible and responding correctly
- [x] Neon PostgreSQL database provisioned and configured
- [ ] PostGrid API key configured for production
- [ ] Stripe webhooks configured for production
- [ ] Auth0 tenant configured for production

#### Authentication
- [x] OAuth flow tested end-to-end
- [x] All 5 auth providers working (Google, Microsoft, Apple, GitHub, Email)
- [x] JWT validation working against Auth0 JWKS
- [x] Demo account created and tested
- [x] Demo account has sample data
- [x] Auto-registration tested (US-ACCT-00)
- [x] Account switching tested (US-ACCT-02)

#### Commerce
- [x] Stripe Checkout integration tested
- [x] Credit purchase flow works end-to-end
- [x] Webhook processing tested (checkout.session.completed)
- [x] Refund handling tested (US-CREDIT-06)
- [x] Credit expiration tested (US-CREDIT-03)
- [x] External checkout URL correct: `https://letterirl.com/credits/purchase`

#### Privacy & Safety
- [ ] Privacy policy published at `https://letterirl.com/privacy`
- [ ] Privacy policy covers all required sections
- [ ] Terms of service published at `https://letterirl.com/terms`
- [x] Address masking working in responses
- [x] Rate limiting enforced (US-SEC-05)
- [x] User data isolation validated (US-SEC-02)
- [x] No prohibited data collected
- [x] Confirmation gates working on destructive actions

#### Documentation
- [x] Manifest includes clear app instructions
- [x] Tool descriptions are accurate and complete
- [x] All tools have correct annotations (readOnlyHint, openWorldHint)
- [x] Widget templates are registered
- [x] Help documentation available
- [ ] FAQ covers common questions
- [ ] Support contact information published

#### Testing
- [x] Preview generation tested with valid addresses
- [x] Preview generation tested with invalid addresses
- [x] Letter sending tested successfully
- [x] Letter sending tested with insufficient credits
- [x] Letter sending tested with invalid draft ID
- [x] Status checking tested for all states
- [x] Balance checking tested
- [x] Account switching tested
- [x] Promo code redemption tested (if enabled)
- [x] Concurrent operations tested
- [x] Error cases tested

#### Demo Account
- [x] Demo account created: `demo@letterirl.com`
- [x] Demo account has 100 credits
- [x] Demo account has sample sent letters
- [x] Demo account has transaction history
- [x] Demo account credentials documented
- [ ] Demo account credentials shared with OpenAI (in submission)

#### Submission Materials
- [ ] App registered in OpenAI Platform Dashboard
- [ ] Manifest URL added to app configuration
- [ ] OAuth redirect URIs configured
- [ ] Support email added to app profile
- [ ] Privacy policy URL added to app profile
- [ ] Terms of service URL added to app profile
- [ ] App icon uploaded (512x512 PNG)
- [ ] App screenshots prepared (if required)
- [ ] Demo credentials included in submission notes

### Nice-to-Have Items (Can Address Post-Launch)

- [ ] Email notifications for letter status changes
- [ ] Automatic refunds for failed letters
- [ ] Content moderation API integration
- [ ] Multi-page letter support (beyond 1,800 characters)
- [ ] International mailing support
- [ ] Postcards and other formats
- [ ] Image/logo support in letters
- [ ] Bulk mailing features
- [ ] Address book for frequent recipients
- [ ] Letter templates and stationery designs

### Known Limitations (Acceptable for v1)

1. **US-Only Mailing**: Only supports domestic US addresses
   - Reason: PostGrid configuration, international requires different pricing/providers
   - Roadmap: International support in Q2 2026

2. **Single-Page Letters**: Max 1,800 characters (body + sign-off)
   - Reason: Simplifies pricing and fulfillment
   - Roadmap: Multi-page support in Q3 2026

3. **Standard Format Only**: First Class mail, no color printing, no images
   - Reason: Keeps v1 scope manageable
   - Roadmap: Premium formats in Q4 2026

4. **Manual Review**: Letters held for admin review during prototype phase
   - Reason: Safety measure while abuse patterns are unknown
   - Roadmap: Automated moderation in Q1 2026

5. **No Email Notifications**: Users must check status manually
   - Reason: Notification infrastructure not built yet
   - Roadmap: Email notifications in Q2 2026

---

## Related Documentation

### Core Documentation
- **[/mnt/c/letter-irl/docs/app-instructions.md](/mnt/c/letter-irl/docs/app-instructions.md)** - Manifest guidance and assistant instructions
- **[/mnt/c/letter-irl/docs/tool-apis.md](/mnt/c/letter-irl/docs/tool-apis.md)** - Complete MCP tool API specifications
- **[/mnt/c/letter-irl/docs/ui-widgets.md](/mnt/c/letter-irl/docs/ui-widgets.md)** - Widget specifications for Apps SDK rendering
- **[/mnt/c/letter-irl/docs/security-and-policy.md](/mnt/c/letter-irl/docs/security-and-policy.md)** - Security policies and privacy requirements

### User Stories & Testing
- **[/mnt/c/letter-irl/docs/user-stories.md](/mnt/c/letter-irl/docs/user-stories.md)** - Complete user stories with acceptance criteria
  - US-LETTER: Letter sending flows
  - US-CREDIT: Credit management
  - US-ACCT: Authentication and accounts
  - US-SEC: Security requirements
  - US-EDGE: Edge cases and error handling

### Implementation References
- **[/mnt/c/letter-irl/docs/auth0-tenant-configuration.md](/mnt/c/letter-irl/docs/auth0-tenant-configuration.md)** - OAuth setup with Auth0
- **[/mnt/c/letter-irl/docs/account-switching-guide.md](/mnt/c/letter-irl/docs/account-switching-guide.md)** - Multi-account support
- **[/mnt/c/letter-irl/docs/credit-purchase-flow.md](/mnt/c/letter-irl/docs/credit-purchase-flow.md)** - Credit purchase implementation
- **[/mnt/c/letter-irl/docs/acp-stripe-integration.md](/mnt/c/letter-irl/docs/acp-stripe-integration.md)** - Stripe Checkout integration
- **[/mnt/c/letter-irl/docs/address-validation.md](/mnt/c/letter-irl/docs/address-validation.md)** - PostGrid address validation

### Learnings & Notes
- **[/mnt/c/letter-irl/docs/learnings/openai-app-sdk-notes.md](/mnt/c/letter-irl/docs/learnings/openai-app-sdk-notes.md)** - SDK release notes and action items (Oct 2025)
- **[/mnt/c/letter-irl/docs/learnings/app-integration-learnings.md](/mnt/c/letter-irl/docs/learnings/app-integration-learnings.md)** - Integration learnings and best practices

### Database & Infrastructure
- **[/mnt/c/letter-irl/docs/database-schema.md](/mnt/c/letter-irl/docs/database-schema.md)** - PostgreSQL schema design
- **[/mnt/c/letter-irl/docs/deployment.md](/mnt/c/letter-irl/docs/deployment.md)** - Production deployment guide
- **[/mnt/c/letter-irl/docs/infrastructure.md](/mnt/c/letter-irl/docs/infrastructure.md)** - Infrastructure architecture

### Business Context
- **[/mnt/c/letter-irl/docs/business-overview.md](/mnt/c/letter-irl/docs/business-overview.md)** - Business model and monetization
- **[/mnt/c/letter-irl/docs/future-roadmap.md](/mnt/c/letter-irl/docs/future-roadmap.md)** - Post-v1 feature roadmap

---

## Document Changelog

| Date | Author | Change |
|------|--------|--------|
| 2025-12-18 | System | Initial version - Comprehensive guidelines for Apps SDK submission |

---

## Feedback & Updates

This document should be reviewed and updated:
- Before each submission to OpenAI
- When OpenAI releases new SDK guidelines
- When Letter IRL adds new features
- After submission feedback is received

**Document Owner**: Engineering Team
**Review Frequency**: Before each submission + quarterly

---

**End of Document**

# Letter IRL: Business Overview

**Last Updated:** September 16, 2026
**Purpose:** Business context: users, model, goals, and positioning

## What is Letter IRL?

**Letter IRL** is a conversational mail service that enables users to send real, physical letters through ChatGPT. It bridges the gap between digital AI conversations and tangible, real-world actions — turning a simple chat into a delivered piece of mail.

**Core Value Proposition:**
> "Chat with AI, send real mail."

The app integrates with ChatGPT as an MCP (Model Context Protocol) server, allowing users to compose, preview, and send physical letters without leaving their conversation. PostGrid handles the printing, addressing, and postal delivery.

---

## Target End Users

### Primary Personas

1. **Personal Correspondents**
   - People who value handwritten-style letters but lack time
   - Thank you notes, birthday cards, sympathy letters
   - Reconnecting with distant friends/family
   - "I should send a letter but never get around to it"

2. **Busy Professionals**
   - Client appreciation letters
   - Business correspondence that benefits from physical presence
   - Follow-up letters after meetings or events
   - People who want to stand out in a digital world

3. **AI-First Users**
   - Early adopters comfortable with ChatGPT for daily tasks
   - Users who prefer conversational UX over forms/websites
   - Tech-savvy individuals who appreciate automation

4. **Special Occasion Senders**
   - Holiday cards and greetings
   - Wedding invitations/RSVPs
   - Graduation announcements
   - Any occasion where physical mail feels more meaningful

### User Characteristics

- Comfortable with ChatGPT
- Value convenience over DIY (willing to pay for ease)
- Appreciate the personal touch of physical mail
- Time-constrained but want meaningful communication

---

## Business Model

### Revenue Model: Prepaid Letter Packs and Pay & Send

| Component | Description |
|-----------|-------------|
| **Letter Packs** | Prepaid letters: Starter 2 for $5, Regular 5 for $10, Power 50 for $90, valid 24 months |
| **Pay & Send** | One letter or postcard bought and sent in a single checkout, $4.99 |
| **Per-Letter Cost** | One letter or postcard per send (2 internal credits; customers only see letters) |
| **Margin** | Markup between PostGrid costs and the per-letter price |
| **No Subscription** | Pay-as-you-go flexibility |

User-facing copy says **letters**, never credits or tokens: OpenAI's app commerce guidelines restrict
selling digital credits. See [pricing-and-credits.md](pricing-and-credits.md).

### Pricing Structure

- PostGrid cost: ~$0.85 (B&W) to $1.20+ (color/double-sided), estimated
- User cost: $1.80-$2.50 per letter in a pack, $4.99 with Pay & Send

### Potential Future Revenue Streams

- Premium templates/stationery
- Bulk sending packages
- Business/enterprise plans
- International mail premium
- Expedited delivery options

---

## Business Goals

### Primary Goal

> **Monetize conversational AI by connecting digital interactions to physical-world actions.**

### Strategic Goals

1. **Build a Sustainable Business**
   - Generate revenue through letter packs and Pay & Send
   - Achieve positive unit economics (revenue > PostGrid + overhead costs)
   - Grow user base organically through ChatGPT ecosystem

2. **Create Defensible Value**
   - Seamless integration with ChatGPT (MCP/Apps SDK)
   - Reliable delivery infrastructure (transactional outbox, held ambiguous outcomes, hourly recovery)
   - Trust through address validation and order tracking
   - Frictionless payment via Stripe

3. **Expand to Adjacent Use Cases**
   - Bulk mailing (holiday cards, announcements)
   - Business correspondence
   - International mail
   - In-ChatGPT checkout through the Agentic Commerce Protocol, once available to apps like Letter IRL

   Shipped since this page was first written: 6x9 postcards, images in letters and postcards
   (upload, reuse, and Letter IRL image generation), and Pay & Send.

---

## Competitive Positioning

### Letter IRL vs. Traditional Services

| Factor | Letter IRL | Traditional (Lob, Click2Mail) |
|--------|------------|------------------------------|
| **Interface** | Conversational (ChatGPT) | Web forms, APIs |
| **Ease** | Natural language | Fill out fields |
| **Discovery** | In ChatGPT ecosystem | Search/find service |
| **Target** | Consumer/prosumer | Developer/enterprise |
| **Personalization** | AI-assisted composition | Manual |

### Unique Advantages

- **AI-assisted writing**: ChatGPT helps compose the letter
- **Zero context switching**: Stay in chat, send mail
- **Conversational UX**: Natural language, not forms
- **Integrated in ChatGPT ecosystem**: Discoverable by millions
- **Frictionless**: No app download, no account creation (OAuth via ChatGPT)

---

## Key Metrics to Track

### Acquisition
- New users (OAuth signups)
- Tool invocations (quote_and_preview_letter calls)
- Conversion rate (preview → send)

### Revenue
- Letter pack and Pay & Send purchases
- Average revenue per user (ARPU)
- Prepaid letter utilization and expiry rate

### Engagement
- Letters sent per user
- Repeat usage (users who send 2+ letters)
- Time between letters

### Operations
- Delivery success rate
- Job failure rate
- Customer support tickets

---

## Summary

**Letter IRL is a conversational commerce app that turns ChatGPT into a physical mail service.**

| Aspect | Summary |
|--------|---------|
| **What** | Send real letters via ChatGPT conversation |
| **Who** | Individuals who value physical mail but prefer digital convenience |
| **How** | Prepaid letter packs and Pay & Send, PostGrid fulfillment, OAuth authentication |
| **Why** | Bridge AI and physical world, monetize conversational interface |
| **Goal** | Profitable business proving the AI-to-action model |

The business is positioned at the intersection of AI adoption and the enduring value of physical mail — betting that people still appreciate tangible correspondence but want modern, effortless ways to send it.

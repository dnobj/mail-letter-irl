# Dashboard Quick Reference

**For when you come back to this later...**

---

## What Was Built

A complete web-based dashboard where users can purchase Letter IRL credits using Stripe Checkout.

**URL**: `https://your-domain.com/dashboard`

---

## Key Files

### Frontend
- `public/dashboard/index.html` - Login page
- `public/dashboard/app.html` - Main dashboard
- `public/dashboard/css/styles.css` - Styles
- `public/dashboard/js/app.js` - JavaScript logic

### Backend
- `src/services/stripeService.ts` - Stripe integration
- `src/api/dashboardApiHandler.ts` - API endpoints (auth + payment)
- `src/utils/cookies.ts` - Cookie utilities
- `src/api/middleware/auth.ts` - Authentication (updated for cookies)

### Configuration
- `.env` - Added Stripe & Auth0 web app credentials (placeholders)

---

## What's Left To Do

### 1. Stripe Setup (5 minutes)

Go to https://dashboard.stripe.com

**Get API Keys**:
- Developers → API keys
- Copy `sk_test_...` and `pk_test_...`

**Set Up Webhook**:
- Developers → Webhooks → Add endpoint
- URL: `https://your-domain.com/webhooks/stripe`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
- Copy signing secret `whsec_...`

**Update `.env`**:
```bash
STRIPE_SECRET_KEY=sk_test_YOUR_KEY
STRIPE_PUBLISHABLE_KEY=pk_test_YOUR_KEY
STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET
```

### 2. Auth0 Setup (5 minutes)

Go to Auth0 Dashboard → Applications

**Create Regular Web Application**:
- Click "Create Application"
- Name: "Letter IRL Dashboard"
- Type: "Regular Web Application"

**Configure**:
- Settings → Allowed Callback URLs:
  `https://your-domain.com/auth/callback`
- Settings → Allowed Logout URLs:
  `https://your-domain.com/dashboard`
- Settings → Allowed Web Origins:
  `https://your-domain.com`
- Copy Client ID and Client Secret

**Update `.env`**:
```bash
LETTER_IRL_OAUTH_CLIENT_ID=your_client_id
LETTER_IRL_OAUTH_CLIENT_SECRET=your_client_secret
```

### 3. Test

```bash
# Restart server
npm run mcp:http

# Open browser
open https://your-domain.com/dashboard

# Login and purchase with test card: 4242 4242 4242 4242
```

---

## How It Works

```
User visits /dashboard
  → Clicks "Sign In with Auth0"
  → Authenticates with Auth0
  → Sees balance and credit packages
  → Clicks "Purchase Regular Pack"
  → Redirects to Stripe Checkout
  → Enters payment info (4242 4242 4242 4242)
  → Payment succeeds
  → Stripe sends webhook to /webhooks/stripe
  → Server adds 10 credits to user account
  → User redirected back to dashboard
  → Balance shows 10 credits ✅
```

---

## Pricing

| Package | Credits | Price | Per Letter |
|---------|---------|-------|------------|
| Starter | 4 | $5.00 | $2.50 |
| Regular | 10 | $10.00 | $2.00 |
| Power | 100 | $90.00 | $1.80 |

All letters cost 2 credits (one page maximum).

---

## Documentation

**Full Implementation Details**:
📄 `docs/dashboard-implementation.md` (31 pages)
- Complete architecture
- Code walkthrough
- Security details
- Database integration

**Setup Instructions**:
📄 `docs/dashboard-setup-guide.md`
- Step-by-step Stripe setup
- Step-by-step Auth0 setup
- Testing guide
- Troubleshooting

**This Quick Reference**:
📄 `docs/dashboard-quick-reference.md`
- High-level overview
- Quick setup steps

---

## Troubleshooting

**Dashboard doesn't load**:
- Check server is running: `lsof -ti:8788`
- Check files exist: `ls public/dashboard/`

**Can't login**:
- Check `.env` has `LETTER_IRL_OAUTH_CLIENT_ID` and `LETTER_IRL_OAUTH_CLIENT_SECRET`
- Check Auth0 callback URL matches your domain

**Purchase fails**:
- Check `.env` has `STRIPE_SECRET_KEY`
- Check Stripe key starts with `sk_test_`
- Check server logs: `tail -f logs/mcp-http.log`

**Credits not added after purchase**:
- Check webhook is configured in Stripe Dashboard
- Check `.env` has `STRIPE_WEBHOOK_SECRET`
- Check ngrok tunnel is active
- Check server logs for webhook events

---

## Status

✅ **Implementation**: 100% complete
⏳ **Configuration**: Needs Stripe + Auth0 keys
⏳ **Testing**: Ready to test once configured

---

## Quick Commands

```bash
# Start server
npm run mcp:http

# Check if running
curl http://localhost:8788/

# View logs
tail -f logs/mcp-http.log

# Kill server
lsof -ti:8788 | xargs kill -9
```

---

**When you're ready to continue**: Just add the Stripe and Auth0 keys to `.env`, restart the server, and test the flow!

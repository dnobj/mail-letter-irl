# Letter IRL User Dashboard - Setup Guide

## Overview

The user dashboard allows customers to:
- View their credit balance
- Purchase credit packages via Stripe Checkout
- View transaction history
- Manage their account

## What We've Built

### Frontend
- **Login Page** (`/dashboard/index.html`) - Auth0 login
- **Main Dashboard** (`/dashboard/app.html`) - Credit management interface
- **Styles** (`/dashboard/css/styles.css`) - Modern, responsive design
- **JavaScript** (`/dashboard/js/app.js`) - API integration and interactions

### Backend
- **Stripe Service** (`src/services/stripeService.ts`) - Stripe Checkout integration
- **Dashboard API** (`src/api/dashboardApiHandler.ts`) - Auth0 OAuth & Stripe endpoints
- **Cookie Utilities** (`src/utils/cookies.ts`) - Session management
- **Auth Middleware** - Supports both Bearer tokens and cookies

### Routes Added to HTTP Server
- `GET /dashboard/*` - Serve dashboard static files
- `GET /auth/login` - Initiate Auth0 login
- `GET /auth/callback` - Handle Auth0 callback
- `POST /auth/logout` - Logout endpoint
- `POST /api/stripe/create-checkout-session` - Create Stripe Checkout
- `POST /webhooks/stripe` - Stripe webhook handler

---

## Setup Steps

### 1. Configure Stripe

#### A. Create Stripe Account
1. Go to https://dashboard.stripe.com
2. Create account or sign in
3. Complete business verification (for live mode)

#### B. Get API Keys
1. Navigate to **Developers → API keys**
2. Copy your keys:
   - **Test Secret Key**: `sk_test_...`
   - **Test Publishable Key**: `pk_test_...`

#### C. Update `.env`
```bash
STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE
STRIPE_PUBLISHABLE_KEY=pk_test_YOUR_KEY_HERE
```

#### D. Set Up Webhook
1. Go to **Developers → Webhooks**
2. Click **Add endpoint**
3. Endpoint URL: `https://your-ngrok-domain.ngrok-free.dev/webhooks/stripe`
4. Select events to listen for:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
5. Copy the **Signing secret**: `whsec_...`
6. Add to `.env`:
```bash
STRIPE_WEBHOOK_SECRET=whsec_YOUR_SECRET_HERE
```

---

### 2. Configure Auth0 Web Application

#### A. Create Regular Web Application
1. Go to Auth0 Dashboard → **Applications**
2. Click **Create Application**
3. Name: "Letter IRL Dashboard"
4. Type: **Regular Web Application**
5. Click **Create**

#### B. Configure Application Settings
1. Go to **Settings** tab
2. Note your **Client ID** and **Client Secret**
3. Add **Allowed Callback URLs**:
   ```
   http://localhost:8788/auth/callback
   https://your-ngrok-domain.ngrok-free.dev/auth/callback
   ```
4. Add **Allowed Logout URLs**:
   ```
   http://localhost:8788/dashboard
   https://your-ngrok-domain.ngrok-free.dev/dashboard
   ```
5. Add **Allowed Web Origins**:
   ```
   http://localhost:8788
   https://your-ngrok-domain.ngrok-free.dev
   ```
6. Click **Save Changes**

#### C. Update `.env`
```bash
LETTER_IRL_OAUTH_CLIENT_ID=your_client_id_here
LETTER_IRL_OAUTH_CLIENT_SECRET=your_client_secret_here
```

---

### 3. Create Stripe Products (Optional)

You can create products in Stripe Dashboard for better tracking:

1. Go to **Products** → **Add product**
2. Create three products:
   - **Starter Pack**: $5.00 (4 credits)
   - **Regular Pack**: $10.00 (10 credits)
   - **Power Pack**: $90.00 (100 credits)

Note: The current implementation creates products dynamically, so this step is optional.

---

## Testing the Dashboard

### 1. Start the Server
```bash
npm run mcp:http
```

### 2. Access the Dashboard
Open your browser to:
- Local: `http://localhost:8788/dashboard`
- Ngrok: `https://your-ngrok-domain.ngrok-free.dev/dashboard`

### 3. Test the Flow

#### A. Login
1. Click "Sign In with Auth0"
2. Use your Auth0 test credentials
3. Should redirect to `/dashboard/app.html`

#### B. View Balance
- Should see your current credit balance
- Should see user email in header

#### C. Purchase Credits
1. Click any "Purchase" button
2. Should redirect to Stripe Checkout
3. Use Stripe test card: `4242 4242 4242 4242`
4. Use any future expiration date
5. Use any 3-digit CVC
6. Complete purchase

#### D. Verify Purchase
1. Should redirect back to dashboard
2. Balance should update
3. Transaction should appear in history

### 4. Verify Webhook
Check server logs for:
```
✅ Checkout completed: cs_test_...
💳 Adding 10 credits to user auth0|...
✅ Credits added successfully
```

---

## Stripe Test Cards

Use these for testing:

| Card Number         | Description        |
|---------------------|-------------------|
| 4242 4242 4242 4242 | Successful payment |
| 4000 0000 0000 0002 | Card declined      |
| 4000 0000 0000 9995 | Insufficient funds |

---

## Troubleshooting

### Issue: "Authentication required" on dashboard
**Solution**: Make sure you've created the Auth0 Regular Web Application and added the correct Client ID/Secret to `.env`

### Issue: Stripe Checkout fails
**Solution**:
1. Check that `STRIPE_SECRET_KEY` is set correctly
2. Verify the key starts with `sk_test_`
3. Check server logs for detailed error

### Issue: Credits not added after purchase
**Solution**:
1. Check webhook is configured in Stripe Dashboard
2. Verify `STRIPE_WEBHOOK_SECRET` is correct
3. Check that ngrok tunnel is active
4. Look for webhook events in Stripe Dashboard → Developers → Webhooks → [Your webhook] → Events

### Issue: "Invalid state parameter" on Auth0 callback
**Solution**:
1. Clear browser cookies
2. Make sure `LETTER_IRL_PUBLIC_BASE_URL` matches your current ngrok domain
3. Update Auth0 callback URLs to match

---

## Architecture

### Purchase Flow

```
User → Dashboard → Auth0 Login → Dashboard App
                                       ↓
                            View Balance & Packages
                                       ↓
                            Click "Purchase" Button
                                       ↓
               POST /api/stripe/create-checkout-session
                                       ↓
                        Stripe Checkout Session Created
                                       ↓
                          Redirect to Stripe Checkout
                                       ↓
                      User Enters Payment Information
                                       ↓
                          Stripe Processes Payment
                                       ↓
              POST /webhooks/stripe (checkout.session.completed)
                                       ↓
                    Add Credits to User Account (Database)
                                       ↓
                   Redirect User Back to Dashboard
                                       ↓
                         Balance Updated ✅
```

### Authentication Flow

```
Dashboard uses cookie-based auth for web sessions
MCP tools use Bearer token auth (JWT)

Both methods supported by: authenticateHttpRequest()
- Checks Authorization header first (Bearer token)
- Falls back to access_token cookie
- Verifies JWT with Auth0
```

---

## Security Features

1. **CSRF Protection**: State parameter in Auth0 flow
2. **HTTPOnly Cookies**: Access tokens not accessible via JavaScript
3. **Secure Cookies**: HTTPS-only in production
4. **Webhook Signature Verification**: Stripe signatures validated
5. **Path Traversal Protection**: Dashboard file serving restricted
6. **JWT Verification**: All API calls require valid Auth0 JWT

---

## Next Steps

1. **Test the complete flow** with test credentials
2. **Switch to live mode** when ready:
   - Use `sk_live_` Stripe keys
   - Update webhook URL for production
   - Set `NODE_ENV=production` in `.env`
3. **Monitor transactions** via Stripe Dashboard
4. **Track usage** via existing Admin API

---

## Files Created/Modified

### New Files
- `public/dashboard/index.html` - Login page
- `public/dashboard/app.html` - Main dashboard
- `public/dashboard/css/styles.css` - Styles
- `public/dashboard/js/app.js` - Frontend logic
- `src/services/stripeService.ts` - Stripe integration
- `src/api/dashboardApiHandler.ts` - API endpoints
- `src/utils/cookies.ts` - Cookie utilities

### Modified Files
- `src/mcp/httpServer.ts` - Added dashboard routes
- `src/api/middleware/auth.ts` - Added cookie auth support
- `.env` - Added Stripe and Auth0 web app config
- `package.json` - Added Stripe SDK

---

## Support

For issues or questions:
1. Check server logs: `tail -f logs/mcp-http.log`
2. Check Stripe Dashboard for webhook events
3. Check Auth0 Dashboard for authentication logs
4. Review this guide for configuration steps

---

**Status**: ✅ Dashboard fully implemented and ready for testing!

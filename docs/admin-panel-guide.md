# Letter IRL - Admin Panel Guide

**Last Updated:** December 4, 2025

## Overview

The Admin Panel is a web-based interface for monitoring and managing the Letter IRL system. It provides real-time access to system statistics, user management, job queue monitoring, credit adjustments, and promo campaign management.

**Location:** `/admin-panel.html` or `http://localhost:8090/admin`

**Security Model:** Local-only access (no authentication required from localhost)

---

## Getting Started

### 1. Start the MCP Server Locally

```bash
cd /mnt/c/letter-irl
npm run dev
```

The server will start on `http://localhost:8090`

### 2. Configure Environment

For local admin access with production database:

```bash
# .env (local)
ADMIN_ENABLED=true
ADMIN_LOCAL_ONLY=true
DATABASE_URL=postgres://...neon.tech/letterirl  # Production Neon DB
DISABLE_WORKERS=true  # Optional: skip job processing
```

### 3. Open the Admin Panel

```bash
# Option 1: Direct URL (recommended)
open http://localhost:8090/admin

# Option 2: Open file directly
open /mnt/c/letter-irl/admin-panel.html
```

**Note:** No JWT token or login required when accessing from localhost.

---

## Sections

### 1. Dashboard

The main dashboard shows at-a-glance system health and alerts.

**Metrics displayed:**
- Total users / New users (today, 7d, 30d)
- Credits held / purchased / used
- Letters sent (today, 7d, 30d, total)
- Revenue (today, 7d, 30d, total)
- Jobs pending / processing / completed / failed

**Alerts:**
- Failed jobs requiring attention
- Credits expiring soon
- Stuck jobs (processing > 10 minutes)
- Open chargebacks (if any)

---

### 2. Users

**Search Users:**
- Search by email or user ID (partial match supported)
- View user details, credits, tier

**Recent Users:**
- List of most recent users
- Quick view of credits and tier

---

### 3. Letters

**Search Letters:**
- Search by letter ID, user ID, or recipient name

**Recent Letters:**
- List of most recent letters
- Status, recipient, creation date

---

### 4. Jobs

**Job Queue:**
- View all letter processing jobs
- Status, attempts, retry button for failed jobs

**Job Lookup:**
- Look up specific job by ID
- View error messages, retry options

---

### 5. Credits

**Adjust Credits:**
- Manually add or remove credits from user
- Requires reason for audit trail
- Records transaction in database

**User Credit Details:**
- Look up user's credit balance
- View recent transactions
- See purchase and usage history

---

### 6. Promos

**Active Campaigns:**
- View all promo campaigns
- Status dropdown to change: Draft, Active, Paused, Ended
- Delete button (only for campaigns with 0 redemptions)
- Redemption counts (current / max total, max per user)

**Create Campaign:**
- Code (case-insensitive, stored as uppercase)
- Name
- Credits Amount (0 for preview-only access)
- Max per User (default: 1)
- Max Total Redemptions (optional, leave empty for unlimited)

**Status States:**
- **Draft:** Not yet active, cannot be redeemed
- **Active:** Users can redeem the code
- **Paused:** Temporarily disabled
- **Ended:** Permanently closed

---

## API Endpoints Summary

### Dashboard & Alerts

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/dashboard` | GET | Comprehensive dashboard metrics |
| `/api/admin/alerts` | GET | Active alerts (failed jobs, expiring credits) |
| `/api/admin/stats` | GET | System-wide statistics (legacy) |

### Users

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/users` | GET | List all users (paginated) |
| `/api/admin/users/search?q=` | GET | Search users by email/ID |
| `/api/admin/users/:userId` | GET | Get user details |

### Letters

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/letters` | GET | List letters with filters |
| `/api/admin/letters/search?q=` | GET | Search letters |
| `/api/admin/letters/:letterId` | GET | Get letter details with job history |

### Jobs

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/jobs` | GET | List all jobs (paginated) |
| `/api/admin/jobs/:jobId` | GET | Get job details |
| `/api/admin/jobs/:jobId/retry` | POST | Retry a failed job |
| `/api/admin/jobs/user/:userId` | GET | Get jobs for user |
| `/api/admin/pgboss/jobs` | GET | View pg-boss queue state |

### Credits

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/credits/adjust` | POST | Adjust user credits |

### Promo Campaigns

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/promo/campaigns` | GET | List all campaigns |
| `/api/admin/promo/campaigns` | POST | Create new campaign |
| `/api/admin/promo/campaigns/:id` | GET | Get campaign details |
| `/api/admin/promo/campaigns/:id` | DELETE | Delete campaign (if no redemptions) |
| `/api/admin/promo/campaigns/:id/status` | PATCH | Update campaign status |
| `/api/admin/promo/campaigns/:id/redemptions` | GET | Get campaign redemptions |

### Stripe Reconciliation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/stripe/reconcile` | GET | Run Stripe reconciliation |
| `/api/admin/stripe/reconcile/fix` | POST | Auto-fix missing credits |

---

## Security

### Local-Only Access Model

The admin panel uses a **local-only security model**:

1. **Railway (production):** `ADMIN_ENABLED=false` - all admin routes return 404
2. **Local development:** `ADMIN_ENABLED=true` - full admin access from localhost

**Why this works:**
- The real security is the Neon DATABASE_URL
- Without production credentials, attackers only see an empty database
- `ADMIN_ENABLED` is defense-in-depth (disabled by default on Railway)
- No admin attack surface exposed on production

### Environment Variables

```bash
# Production (Railway) - admin disabled
ADMIN_ENABLED=false

# Local admin access
ADMIN_ENABLED=true
ADMIN_LOCAL_ONLY=true
```

### Proxy Protection

Admin routes block requests coming through proxies (ngrok, etc.):
- Checks `x-forwarded-for` header
- Checks `x-real-ip` header
- Checks `ngrok-agent-ips` header

---

## Troubleshooting

### Admin panel shows "Not found"

**Problem:** Admin routes are disabled

**Solution:**
1. Check `ADMIN_ENABLED=true` in `.env`
2. Restart the server
3. Access from localhost only (not through ngrok)

### CORS errors on DELETE/PATCH

**Problem:** Browser blocking admin requests

**Solution:** This was fixed in the codebase. Make sure you have the latest code and restart the server.

### "Error updating status" or "Error deleting campaign"

**Problem:** API request failed

**Solution:**
1. Check server console for error details
2. Verify campaign exists
3. For delete: campaign must have 0 redemptions

### Cannot delete campaign

**Problem:** Campaign has existing redemptions

**Solution:** Set status to "Ended" instead. Campaigns with redemptions cannot be deleted to preserve audit trail.

---

## Best Practices

### Promo Campaigns

- Use **descriptive codes** (e.g., `EARLYBIRD`, `WELCOME5`)
- Set **max total redemptions** for limited offers
- Use **0 credits** for preview-only access codes
- **Pause** campaigns instead of deleting if unsure
- **End** campaigns when promotion is complete

### Credit Adjustments

- Always provide a **detailed reason** for audit trail
- **Verify user first** using User Lookup
- **Document externally** for large adjustments
- **Communicate with user** about manual adjustments

### Job Monitoring

- Check **failed jobs** regularly
- **Retry** jobs that failed due to transient errors
- Review **error messages** for patterns

---

## Technical Details

### Technology Stack

- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **Styling:** Dark theme with accent color
- **Storage:** No localStorage needed (local-only access)
- **API:** RESTful HTTP endpoints

### File Location

```
/mnt/c/letter-irl/admin-panel.html
```

### Browser Compatibility

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

---

**Admin Panel Version:** 2.0
**Last Updated:** December 4, 2025

# Letter IRL - Admin Panel Guide

**Last Updated:** November 15, 2025

## Overview

The Admin Panel is a web-based interface for monitoring and managing the Letter IRL system. It provides real-time access to system statistics, user management, job queue monitoring, and credit adjustments.

**Location:** `/admin-panel.html`

**Server:** `http://localhost:8788`

---

## Getting Started

### 1. Start the MCP Server

```bash
cd /mnt/c/letter-irl
npm run mcp:http
```

The server will start on `http://localhost:8788`

### 2. Get Your JWT Token

**Option A: From Server Logs**
When you authenticate via ChatGPT, the server logs will show your JWT token:
```
🔓 OAuth flow complete for user: auth0|...
JWT: eyJhbGc...
```

**Option B: Extract from ChatGPT Session**
Use your browser's developer tools to inspect the Authorization header in ChatGPT's MCP requests.

### 3. Open the Admin Panel

Open `admin-panel.html` in your browser:
```bash
# Option 1: Direct file
open /mnt/c/letter-irl/admin-panel.html

# Option 2: Via HTTP server (if serving)
open http://localhost:8788/admin-panel.html
```

### 4. Configure Authentication

1. Paste your JWT token into the "JWT Token" field
2. Click "Save Token"
3. The token is stored in localStorage for future sessions

**Note:** You must be an admin user (listed in `LETTER_IRL_ADMIN_USER_IDS` environment variable)

---

## Features

### 1. System Stats 📈

**Endpoint:** `GET /api/admin/stats`

**What it shows:**
- Total users and credits held
- Credits purchased vs. credits used
- Total letters sent
- Order count and revenue
- Success rate

**Usage:**
1. Click "Load Stats"
2. View real-time system metrics

---

### 2. Users List 👥

**Endpoint:** `GET /api/admin/users`

**What it shows:**
- All users (paginated, limit 10)
- Email address
- Current credit balance
- Total credits purchased
- Total credits used

**Usage:**
1. Click "Load Users"
2. Browse user list
3. Copy user IDs for detailed lookup

**Features:**
- Pagination (default: 10 users)
- Sortable columns
- Quick overview of user activity

---

### 3. User Lookup 🔍

**Endpoint:** `GET /api/admin/users/:userId`

**What it shows:**
- Complete user profile
- Credit statistics (balance, purchased, used)
- Total letters sent
- Recent transaction history (last 10)
- User metadata (created/updated dates)

**Usage:**
1. Enter full user ID (e.g., `google-oauth2|100183416573162262799`)
2. Click "Look Up User"
3. View detailed user information

**Note:** User IDs are displayed in full (no truncation) for accurate copy/paste

**Use Cases:**
- Customer support inquiries
- Investigating credit discrepancies
- Auditing user activity
- Verifying transaction history

---

### 4. Job Queue ⚙️

**Endpoint:** `GET /api/admin/jobs`

**What it shows:**
- All letter processing jobs
- Job status (pending, processing, completed, failed)
- Attempt count (current/max)
- Created timestamp

**Usage:**
1. Click "Load Jobs" - Shows jobs from our `letter_jobs` table
2. Click "Load pg-boss Jobs" - Shows raw pg-boss queue state

**Job Statuses:**
- `pending` - Waiting to be processed
- `processing` - Currently being processed
- `completed` - Successfully completed
- `failed` - Failed after max retries
- `retry` - Scheduled for retry

---

### 5. Job Lookup 🔍

**Endpoint:** `GET /api/admin/jobs/:jobId`

**What it shows:**
- Complete job details
- Status and attempt count
- Timestamps (created, started, completed)
- Error messages (if failed)
- Associated letter details (recipient, message preview)

**Usage:**
1. Enter job ID (UUID)
2. Click "Look Up Job"
3. View job and letter details

**Use Cases:**
- Debugging failed jobs
- Tracking letter delivery status
- Investigating delays
- Customer support

---

### 6. User Jobs Lookup 📋

**Endpoint:** `GET /api/admin/jobs/user/:userId`

**What it shows:**
- All jobs for a specific user
- Job status and attempts
- Letter IDs
- Created timestamps

**Usage:**
1. Enter user ID (e.g., `auth0|123456...`)
2. Click "Load User Jobs"
3. View all jobs for that user

**Use Cases:**
- Tracking user's letter sending history
- Investigating delivery issues
- Customer support

---

### 7. Credit Adjustment 💰

**Endpoint:** `POST /api/admin/credits/adjust`

**What it does:**
- Manually add or remove credits
- Records transaction in audit trail
- Updates user balance atomically

**Usage:**
1. Enter user ID
2. Enter amount (positive to add, negative to remove)
3. Enter reason (required for audit trail)
4. Click "Adjust Credits"

**Examples:**
```
User ID: google-oauth2|100183416573162262799
Amount: +25
Reason: Customer service credit for delayed delivery

User ID: auth0|507f1f77bcf86cd799439011
Amount: -5
Reason: Correction for duplicate charge
```

**Audit Trail:**
- All adjustments are logged in `credit_transactions` table
- Reason includes admin user ID
- Complete before/after balance tracking

---

## API Endpoints Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/stats` | GET | System-wide statistics |
| `/api/admin/users` | GET | List all users (paginated) |
| `/api/admin/users/:userId` | GET | Get user details |
| `/api/admin/jobs` | GET | List all jobs (paginated) |
| `/api/admin/jobs/:jobId` | GET | Get job details |
| `/api/admin/jobs/user/:userId` | GET | Get jobs for user |
| `/api/admin/pgboss/jobs` | GET | View pg-boss queue state |
| `/api/admin/credits/adjust` | POST | Adjust user credits |

---

## Security

### Authentication

- **JWT Required:** All endpoints require valid JWT token
- **Admin Authorization:** User must be in admin whitelist
- **Token Storage:** Stored in browser localStorage (client-side only)

### Admin Whitelist

Configured via environment variable:
```bash
LETTER_IRL_ADMIN_USER_IDS=auth0|abc123,auth0|def456
```

**To add an admin:**
1. Get user's Auth0 user ID
2. Add to `LETTER_IRL_ADMIN_USER_IDS` in `.env`
3. Restart server

### CORS

- Server has CORS enabled for localhost
- Allows: `GET`, `POST`, `OPTIONS`
- Required headers: `Authorization`, `Content-Type`

---

## Troubleshooting

### "Please set your JWT token first"

**Problem:** No JWT token configured

**Solution:**
1. Get JWT from server logs or ChatGPT session
2. Paste into token field
3. Click "Save Token"

### "Unauthorized" or "Forbidden"

**Problem:** User is not in admin whitelist

**Solution:**
1. Verify user ID is correct
2. Check `LETTER_IRL_ADMIN_USER_IDS` in `.env`
3. Restart server after adding user

### "Error: User not found"

**Problem:** User ID doesn't exist in database

**Solution:**
1. Verify user ID is correct (case-sensitive)
2. Check if user has authenticated at least once
3. Use "Users List" to find correct user ID

### CORS Errors

**Problem:** Browser blocking requests

**Solution:**
1. Ensure server is running on `http://localhost:8788`
2. Check browser console for specific error
3. Verify CORS headers in server logs

### Token Expired

**Problem:** JWT token has expired (24 hours)

**Solution:**
1. Get fresh JWT from new ChatGPT session
2. Update token in admin panel
3. Click "Save Token"

---

## Best Practices

### 1. Credit Adjustments

- **Always provide detailed reason** - Required for audit trail
- **Verify user first** - Use User Lookup to confirm identity
- **Document externally** - Keep separate records for large adjustments
- **Communicate with user** - Inform users of manual adjustments

### 2. Job Monitoring

- **Check pg-boss queue regularly** - Identify stuck jobs
- **Monitor failed jobs** - Investigate and retry if needed
- **Track completion rates** - Identify systemic issues
- **Review error messages** - Pattern analysis for bugs

### 3. User Support

- **Look up user first** - Get complete context before adjusting
- **Check transaction history** - Verify reported issues
- **Review job status** - Confirm delivery status
- **Document actions** - Keep support ticket trail

### 4. Security

- **Protect JWT tokens** - Don't share or commit to repos
- **Rotate admin access** - Review whitelist regularly
- **Monitor admin actions** - All actions are logged
- **Use secure connections** - HTTPS in production

---

## Future Enhancements

Potential features for future versions:

- [ ] Auto-refresh for real-time monitoring
- [ ] Export data to CSV
- [ ] Advanced filtering and search
- [ ] Job retry/cancel buttons
- [ ] User creation/deletion
- [ ] Bulk credit operations
- [ ] Analytics dashboard with charts
- [ ] Email notifications for failed jobs
- [ ] Activity logs viewer
- [ ] Multi-admin audit trail

---

## Technical Details

### Technology Stack

- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **Styling:** Custom CSS with gradient theme
- **Storage:** localStorage for token persistence
- **API:** RESTful HTTP endpoints
- **Auth:** JWT Bearer tokens

### File Location

```
/mnt/c/letter-irl/admin-panel.html
```

### Dependencies

- None (self-contained HTML file)
- Requires running MCP HTTP server
- Modern browser with localStorage support

### Browser Compatibility

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

---

## Support

For issues or questions:

1. Check server logs for errors
2. Review `docs/STATUS.md` for system status
3. Consult `src/api/adminApiHandler.ts` for API details
4. Check browser console for client-side errors

---

## Quick Reference

### Common User IDs Format
```
auth0|1234567890abcdef
```

### Common Job IDs Format
```
550e8400-e29b-41d4-a716-446655440000 (UUID)
```

### Sample API Calls (curl)

```bash
# Get stats
curl -H "Authorization: Bearer YOUR_JWT" \
  http://localhost:8788/api/admin/stats

# Get user
curl -H "Authorization: Bearer YOUR_JWT" \
  http://localhost:8788/api/admin/users/auth0|123456

# Adjust credits
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"userId":"auth0|123456","amount":25,"reason":"Test"}' \
  http://localhost:8788/api/admin/credits/adjust
```

---

**Admin Panel Version:** 1.0
**Last Updated:** November 15, 2025
**Maintained By:** Letter IRL Team

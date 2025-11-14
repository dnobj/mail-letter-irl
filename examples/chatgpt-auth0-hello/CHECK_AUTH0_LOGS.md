# How to Check Auth0 Logs for Errors

When ChatGPT shows "Something went wrong with setting up the connection", the real error is in Auth0's logs.

## Step 1: Open Auth0 Logs

1. **Go to Auth0 Dashboard**
2. Click **Monitoring** in the left sidebar
3. Click **Logs**
4. You should see recent log entries

## Step 2: Look for Recent Failures

Filter or look for:
- **Red entries** (errors/failures)
- **Timestamps** matching when you just tried to connect from ChatGPT
- **Type**: Look for:
  - `feccft` - Failed Exchange (Client Credentials for Access Token)
  - `feacft` - Failed Exchange (Authorization Code for Access Token)
  - `fcpro` - Failed Cross Origin Authentication
  - `fapi` - Failed API Operation
  - Any entry with "failed" or "denied"

## Step 3: Click on Error Entries

Click on any red/failed entries to see:
- **Description** - What failed
- **Details** - Full error message
- **User Agent** - Should be from ChatGPT/OpenAI
- **Connection** - Which connection was involved
- **Application** - The dynamically registered client

## Common Errors and Solutions

### Error: "Grant type 'authorization_code' not allowed"

**Cause**: DCR registered client doesn't have the right grant types

**Solution**: This is an Auth0 configuration issue. Check:
- Dashboard → Settings → Advanced → Grant Types
- Make sure "Authorization Code" is available for DCR clients

### Error: "Audience not allowed"

**Cause**: Default Audience not set or API doesn't exist

**Solution**:
1. Dashboard → Settings → Advanced
2. Set **Default Audience** to `https://letter-irl/api`
3. Verify the API exists: Dashboard → Applications → APIs

### Error: "Invalid redirect_uri"

**Cause**: Dynamically registered client has wrong callback URL

**Solution**: This shouldn't happen with DCR, but if it does:
- Check Auth0's DCR configuration
- Make sure DCR is properly enabled

### Error: "Client not found" or "Client authentication failed"

**Cause**: DCR registration failed or client was deleted

**Solution**: Try again - ChatGPT will register a new client

### Error: "No connections enabled"

**Cause**: Database connection not enabled for dynamically registered clients

**Solution**:
1. Dashboard → Authentication → Database
2. Click on `Username-Password_Authentication`
3. Applications tab → Enable for all applications

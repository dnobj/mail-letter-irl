# Fix: "no connections enabled for the client"

## The Error

When trying to connect from ChatGPT, you see:
```
error=invalid_request&error_description=no+connections+enabled+for+the+client
```

## What This Means

ChatGPT successfully registered a dynamic OAuth client, but Auth0 rejected the login attempt because the client has no **authentication connections** enabled.

**Connections** in Auth0 are identity providers like:
- Username-Password Database
- Google Social Login
- GitHub Social Login
- etc.

Dynamically registered clients don't automatically inherit connection settings.

## Solution: Enable Default Connection for All Applications

### Step 1: Find Your Database Connection

1. **Go to Auth0 Dashboard**
2. Click **Authentication** in left sidebar
3. Click **Database**
4. You should see a connection (usually named `Username-Password-Authentication`)
5. Click on it

### Step 2: Enable for All Applications

In the connection settings:

1. Click the **Applications** tab
2. Look for a toggle/checkbox: **"Enable this connection for all applications"**
3. **Toggle it ON**
4. Click **Save**

### Alternative: Enable via Connection Settings

If you don't see the "all applications" option:

1. In the Database connection settings
2. Go to the **Applications** tab
3. You'll see a list of applications
4. **Manually enable** any applications created by ChatGPT (they'll have auto-generated names)

**Problem**: You'd need to do this for every new dynamically registered client!

## Better Solution: Configure Default Connection

### Set Tenant-Wide Default

1. **Auth0 Dashboard** → **Settings** → **General** (or **Advanced**)
2. Look for **"Default Directory"**
3. Set to: `Username-Password-Authentication` (or your database name)
4. Click **Save Changes**

This ensures all applications (including dynamically registered ones) use this connection.

## Verify Your Connection is Active

1. **Auth0 Dashboard** → **Authentication** → **Database**
2. Click on your database connection
3. Make sure:
   - ✅ Connection is **enabled**
   - ✅ Has at least one **user** (or can create users)
   - ✅ **Applications** tab shows it's available

## Create a Test User (If Needed)

If you don't have any users in your database:

1. **Auth0 Dashboard** → **User Management** → **Users**
2. Click **+ Create User**
3. Fill in:
   - **Email**: your email
   - **Password**: create a password
   - **Connection**: Select your database
4. Click **Create**

## Test the OAuth Flow Manually

After enabling connections, test it works:

1. Go to ChatGPT
2. Try adding your connector again
3. You should now see an Auth0 login page
4. Log in with your test user
5. Authorize the application

## Alternative: Use Social Connections

Instead of username/password, you can enable social logins:

### Enable Google Login

1. **Auth0 Dashboard** → **Authentication** → **Social**
2. Click **+ Create Connection**
3. Select **Google**
4. Follow the setup wizard
5. Make sure to **enable for all applications**

### Enable GitHub Login

1. **Auth0 Dashboard** → **Authentication** → **Social**
2. Click **+ Create Connection**
3. Select **GitHub**
4. Follow the setup wizard
5. Make sure to **enable for all applications**

## Common Issues

### Issue: "No connections enabled" persists

**Cause**: Changes not applied to dynamically registered clients

**Solution**:
1. Delete the old dynamically registered clients:
   - Auth0 Dashboard → Applications → Applications
   - Look for auto-generated application names
   - Delete them
2. Try connecting from ChatGPT again (it will create a new client)

### Issue: "Connection not found"

**Cause**: Connection is disabled or deleted

**Solution**:
- Make sure your database connection exists and is enabled
- Check Authentication → Database

### Issue: Can't find "Enable for all applications"

**Cause**: Different Auth0 UI versions

**Solution**:
- Look for "Enable this connection for applications"
- Or manually enable for specific applications in the Applications tab

## Verification Checklist

Before trying ChatGPT again:

- [ ] Database connection exists (Authentication → Database)
- [ ] Connection is enabled
- [ ] Connection is enabled for "all applications" OR for your dynamically registered clients
- [ ] At least one test user exists
- [ ] Default Directory is set (optional but recommended)
- [ ] Restarted your MCP server (`npm run dev`)

## Try ChatGPT Again

Once connections are enabled:

1. Go to ChatGPT
2. Try adding connector: `https://amitotically-gubernacular-elise.ngrok-free.dev/manifest.json`
3. You should see Auth0 login page
4. Log in with your credentials
5. Authorize the application
6. Connection should succeed!

## Watch Your Debug Logs

Open debug logs to see the OAuth flow:
```
https://amitotically-gubernacular-elise.ngrok-free.dev/debug/logs
```

You should see:
1. ✅ OAuth metadata requests (200 OK)
2. ✅ SSE stream request with Bearer token
3. ✅ Session established
4. ✅ Tool invocations

## Yes, You Have Tools!

Your server exposes a `hello_world` tool that:
- Accepts an optional `name` parameter
- Returns a greeting with your authenticated user info
- Demonstrates the full OAuth → Tool flow

Once connected, try in ChatGPT:
```
Use the hello_world tool to greet me
```

Expected response:
```
Hello, friend! Authenticated as auth0|xxxxx (your@email.com).
```

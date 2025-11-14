# ⚠️ CRITICAL Auth0 Settings for ChatGPT

These are the **two most important** Auth0 configurations for ChatGPT integration:

## 🔴 1. Default Audience (MOST CRITICAL!)

**Why it's needed**: ChatGPT doesn't send the `audience` parameter in OAuth requests. Without Default Audience, Auth0 will issue **opaque tokens** (random strings) instead of **JWTs**, and your server won't be able to validate them.

**Symptom if missing**: You'll see this error:
```
[ERROR] [auth] Token validation failed: invalid signature
```

### How to Set Default Audience

1. **Go to Auth0 Dashboard**
2. Click **Settings** in left sidebar (gear icon)
3. Click **Advanced** tab
4. Scroll down to find **Default Audience** field
5. Enter: `https://letter-irl/api`
6. Scroll to bottom and click **Save Changes**

**Verify**: The Default Audience field should now show `https://letter-irl/api`

## 🔴 2. CORS Configuration

**Why it's needed**: ChatGPT makes cross-origin requests to Auth0. Without CORS, the OAuth flow will fail.

**Symptom if missing**: Browser console shows:
```
blocked by CORS policy
```

### How to Set CORS

1. **Go to Auth0 Dashboard**
2. Click **Settings** in left sidebar (gear icon)
3. Click **Advanced** tab
4. Find **Allowed Origins (CORS)** field
5. Add these lines:
   ```
   https://chat.openai.com
   https://chatgpt.com
   ```
6. Click **Save Changes** at bottom

## ✅ Verification Steps

After configuring both settings:

### Test 1: Verify Default Audience is Set
1. Go to Settings → Advanced
2. Confirm **Default Audience** shows: `https://letter-irl/api`

### Test 2: Verify CORS is Set
1. Go to Settings → Advanced
2. Confirm **Allowed Origins (CORS)** includes:
   - `https://chat.openai.com`
   - `https://chatgpt.com`

### Test 3: Get a Test Token
```bash
# Use Auth0's "Test" tab in your API settings to get a test token
# Then decode it at jwt.io and verify:
# - "aud" claim is "https://letter-irl/api"
# - Token is a JWT (not an opaque string)
```

## 📋 Quick Reference

| Setting | Location | Value |
|---------|----------|-------|
| Default Audience | Settings → Advanced | `https://letter-irl/api` |
| CORS | Settings → Advanced | `https://chat.openai.com`<br>`https://chatgpt.com` |
| API Identifier | Applications → APIs → Letter IRL API | `https://letter-irl/api` |

**All three MUST match exactly!**

## 🚨 Common Mistakes

❌ **Setting Default Audience to a different value than API Identifier**
✅ They must match exactly: `https://letter-irl/api`

❌ **Forgetting the trailing slash on AUTH0_ISSUER**
✅ Use: `https://dev-ky21dxn3qmi71hjl.us.auth0.com/` (with `/`)

❌ **Looking for CORS in API settings**
✅ CORS is in Tenant Settings → Advanced (global setting)

❌ **Not saving changes**
✅ Always click "Save Changes" at bottom of page!

## 🎯 You're Done When...

- [ ] Default Audience is set to `https://letter-irl/api`
- [ ] CORS includes ChatGPT origins
- [ ] Both settings are **saved** (clicked Save Changes)
- [ ] Test tokens have correct `aud` claim

Once these two settings are correct, the OAuth flow should work!

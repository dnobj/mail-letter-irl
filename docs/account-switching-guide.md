# Account Switching Guide

**Last Updated:** November 18, 2025

This guide explains how to switch between different accounts or authentication methods when using Letter IRL in ChatGPT.

---

## Overview

Letter IRL supports **5 authentication methods**:
- 🔵 **Google** - Sign in with your Google account
- 🔵 **Microsoft** - Sign in with your Microsoft account
- 🍎 **Apple** - Sign in with Apple
- 🐙 **GitHub** - Sign in with your GitHub account
- 📧 **Email/Password** - Create an account with email and password

---

## Why Switch Accounts?

You might want to switch accounts to:
- Use a different email address
- Access letters from another account
- Try a different authentication provider
- Separate personal and business correspondence
- Test the service with multiple identities

---

## How to Switch Accounts

### Method 1: Using the `switch_account` Tool (Recommended)

The easiest way to switch accounts is by asking ChatGPT directly:

**Example prompts:**
- "I want to switch my Letter IRL account"
- "Switch my account"
- "Log out and use a different account"
- "Change my authentication method"

**What happens:**
1. ChatGPT calls the `switch_account` tool
2. You receive a logout URL and clear instructions
3. Click the logout link to end your current Auth0 session
4. Reconnect to Letter IRL in ChatGPT
5. Choose your preferred authentication method from the login screen

### Method 2: Manual Logout

You can also manually log out by visiting the Auth0 logout URL directly:

```
https://dev-ky21dxn3qmi71hjl.us.auth0.com/v2/logout
```

After logging out:
1. Reconnect to Letter IRL in ChatGPT
2. The Auth0 Universal Login screen will appear
3. Select your preferred authentication method

---

## Checking Your Current Account

To see which account you're currently using, simply ask for your balance:

**Example prompts:**
- "What's my balance?"
- "Check my credits"
- "How many credits do I have?"

**Response includes:**
```
Account: user@example.com (Google)
Balance: 195 credits — That's enough for 97 letters.

Tip: Use the switch_account tool to log in with a different account.
```

This shows:
- ✅ Your email address
- ✅ Your authentication provider
- ✅ Your credit balance

---

## Authentication Methods Explained

### Google
- Use any Google account (@gmail.com or Google Workspace)
- Single sign-on with Google credentials
- OAuth 2.0 secure authentication

### Microsoft
- Use Microsoft personal accounts (Outlook, Hotmail, Live)
- **Note:** This is for personal Microsoft accounts only, not organizational/work accounts

### Apple
- Sign in with Apple ID
- Enhanced privacy with Apple's authentication

### GitHub
- Use your GitHub account credentials
- OAuth authentication through GitHub

### Email/Password
- Create a dedicated Letter IRL account
- Set your own password
- MFA (Multi-Factor Authentication) available for enhanced security

---

## Account Data

**Important:** Each authentication method creates a **separate account** with:
- Separate credit balance
- Separate letter history
- Separate user profile

If you sign in with Google and later sign in with Microsoft, these will be **two different accounts**.

### Account Linking (Future Feature)

Currently, Letter IRL creates separate accounts for each authentication method. In the future, we may add account linking to allow:
- Merging multiple authentication methods to one account
- Transferring credits between accounts
- Unified letter history across authentication methods

---

## Security Best Practices

1. **Use Strong Authentication**
   - Enable MFA on your authentication provider
   - Use a strong password for Email/Password accounts
   - Keep your authentication credentials secure

2. **Logout on Shared Devices**
   - Always use the `switch_account` tool on shared computers
   - Don't leave your session active on public devices

3. **Monitor Your Account**
   - Regularly check your balance and transaction history
   - Report any suspicious activity

4. **Choose Your Primary Method**
   - Pick one authentication method as your primary account
   - Keep track of which provider you used for purchases

---

## Troubleshooting

### "Auth0 Remembers My Login"

**Problem:** Auth0 automatically logs you in with the same provider.

**Solution:** Use the `switch_account` tool to clear your Auth0 session first.

### "I Can't See My Letters"

**Problem:** You signed in with a different authentication method.

**Cause:** Each authentication method creates a separate account.

**Solution:** Log out and sign in with the original authentication method you used.

### "Session Expired"

**Problem:** Your authentication session has timed out.

**Solution:**
- Reconnect to Letter IRL in ChatGPT
- Authenticate again with your preferred method

### "Wrong Email Showing"

**Problem:** The wrong email address is displayed in your balance.

**Cause:** You're logged in with a different account.

**Solution:**
- Use `switch_account` to log out
- Sign in with the correct authentication provider
- Verify your email in the balance display

---

## FAQs

**Q: Can I merge accounts from different providers?**
A: Not currently. Each authentication method creates a separate account. Account linking is a planned future feature.

**Q: Will my credits transfer if I switch accounts?**
A: No. Credits are tied to each individual account. If you switch to a different authentication method, you'll have a separate credit balance.

**Q: How do I know which account I'm using?**
A: Check your balance - it displays your email and authentication provider.

**Q: Can I use the same email with different providers?**
A: Yes, but they will still be separate accounts. For example, `user@gmail.com` via Google and `user@gmail.com` via Email/Password are two different accounts.

**Q: What happens to my letters if I switch accounts?**
A: Your letters stay with the account that created them. To access old letters, sign back in with the original authentication method.

**Q: Is it secure to switch accounts frequently?**
A: Yes, the `switch_account` tool properly logs you out of Auth0 before reconnecting.

**Q: Can I delete an account?**
A: Contact support to request account deletion. See the main documentation for contact information.

---

## Quick Reference

| Action | ChatGPT Prompt |
|--------|----------------|
| Switch accounts | "Switch my Letter IRL account" |
| Check current account | "What's my balance?" |
| Logout manually | Visit the logout URL from switch_account |
| Choose auth method | Will be prompted after logout |

---

## Related Documentation

- [Auth0 Tenant Configuration](./auth0-tenant-configuration.md) - Technical Auth0 setup
- [Tool API Specifications](./tool-apis.md) - Complete tool documentation
- [Project Status](./STATUS.md) - Current project status

---

## Support

If you encounter issues with account switching:
1. Check the troubleshooting section above
2. Review the Auth0 configuration documentation
3. Check Auth0 logs in the dashboard
4. Contact support at the email listed in the main documentation

---

**Last Updated:** November 18, 2025
**Feature Version:** 0.1.0
**Tool Added:** Phase 1 Enhancement

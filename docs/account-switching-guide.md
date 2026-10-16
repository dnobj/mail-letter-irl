# Account Switching Guide

**Last Updated:** September 16, 2026

> **Partly out of date.** The `switch_account` tool this guide recommends was removed
> (commit `b5045bf`, "not useful in practice"); no Letter IRL tool logs you out. Switch accounts by
> disconnecting Letter IRL in ChatGPT's app settings, ending the Auth0 session (Method 2), and
> connecting again. The Auth0 logout URL below is the **development** tenant; production uses
> `https://dev-njmdyqf8n25rqgy7.us.auth0.com/v2/logout`.

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

### Method 1: Using the `switch_account` Tool (removed)

This tool no longer exists. The description below is kept for history.

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

`get_account_balance` returns the letters remaining, letters expiring soon, and image generations
left. It does not return the email address or login provider, so the balance alone does not identify
the account. The letterirl.com dashboard shows the signed-in account.

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

**Your account is your email address.** Sign in with Google today and with a
password tomorrow, on the same confirmed address, and you arrive at the same
account: one balance, one letter history, one profile.

The linking happens at sign-in, in an Auth0 post-login Action, and it needs the
address to be **confirmed** - otherwise anyone could claim someone else's
account by typing their address into a new sign-up. So:

- A new password account must confirm its address before its first sign-in.
- An Apple sign-in that hides your address behind a private relay address is a
  different address, and therefore a different account. Turn off "Hide My
  Email" if you want it joined to the rest.
- If a sign-in arrives with no confirmed address at all, Letter IRL opens no
  account and says so, rather than opening one it cannot connect to you.

### Accounts opened before this (2026-09)

Letter IRL used to key an account on the sign-in method, so one person could
have several. Those accounts still exist and are merged on request - email
support@letterirl.com from the address they share.

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

**Cause:** The two methods carry different email addresses - an Apple private
relay address, a work address and a personal one, or an account opened before
2026-09, when each method was its own account.

**Solution:** Sign in with the method whose address matches the account, or
email support@letterirl.com to have the two joined.

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
A: Methods sharing one confirmed address are joined automatically at sign-in.
Accounts on genuinely different addresses, and accounts opened before 2026-09,
are merged by support: email support@letterirl.com from one of the addresses.

**Q: Will my credits transfer if I switch accounts?**
A: There is nothing to transfer when both methods carry the same confirmed
address - it is one balance. Two different addresses are two accounts, and
their balances stay where they are until the accounts are merged.

**Q: How do I know which account I'm using?**
A: Check your balance - it displays the account's email address. It no longer
names a sign-in method, because an account can have several.

**Q: Can I use the same email with different providers?**
A: Yes, and it is one account. `user@gmail.com` through Google and
`user@gmail.com` through Email/Password are the same account, provided the
address is confirmed on both.

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
- [Project Status](./status.md) - Current project status

---

## Support

If you encounter issues with account switching:
1. Check the troubleshooting section above
2. Review the Auth0 configuration documentation
3. Check Auth0 logs in the dashboard
4. Contact support at the email listed in the main documentation

---

**Feature Version:** 0.1.0
**Tool:** `switch_account`, added in Phase 1 and later removed (`b5045bf`)

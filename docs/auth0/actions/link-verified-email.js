const { ManagementClient } = require("auth0");

/**
 * Link a person's sign-in methods onto one confirmed email address.
 *
 * Auth0 mints a subject per sign-in method, and Letter IRL keys an account on
 * the subject, so without this one person signing in with Google and with a
 * password is two subjects presenting one address - and users.email is UNIQUE.
 * The second one collides, is refused, and that person has no account at all.
 *
 * Runs BEFORE the email-claim Action in the Post Login flow.
 *
 * Written against the auth0 SDK v7 (pinned in Dependencies). v7 is not v4:
 * there is no usersByEmail manager and no users.link, and awaiting a call
 * returns the payload itself rather than { data }.
 */

const RESEND_INTERVAL_MS = 10 * 60 * 1000;
const TOKEN_CACHE_KEY = "linking_management_token";

// One Management API token for many logins (#428). Minting one per login
// spends the tenant's machine-to-machine token quota, and when that runs out
// this Action fails, which denies every login.
async function managementToken(event, api) {
  const cached = api.cache.get(TOKEN_CACHE_KEY);
  if (cached && typeof cached.value === "string") return cached.value;
  const response = await fetch("https://" + event.secrets.AUTH0_DOMAIN + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: event.secrets.LINKING_CLIENT_ID,
      client_secret: event.secrets.LINKING_CLIENT_SECRET,
      audience: "https://" + event.secrets.AUTH0_DOMAIN + "/api/v2/"
    })
  });
  if (!response.ok) throw new Error("management token request failed: " + response.status);
  const body = await response.json();
  // An hour short of the token's lifetime, and inside the cache's 24-hour
  // ceiling. A token the cache refuses is simply used for this login.
  const ttl = Math.min((body.expires_in - 3600) * 1000, 23 * 60 * 60 * 1000);
  if (ttl > 0) api.cache.set(TOKEN_CACHE_KEY, body.access_token, { ttl });
  return body.access_token;
}

async function management(event, api) {
  return new ManagementClient({
    domain: event.secrets.AUTH0_DOMAIN,
    token: await managementToken(event, api)
  });
}

// Re-send a password account's confirmation link at most once every ten
// minutes (#428). Auth0 sends its own link at sign-up, so the sign-up counts
// as the last send: no second email right after it, however quickly the
// person tries to sign in again. Best-effort: if the send fails, the refusal
// still stands.
async function resendConfirmation(event, api) {
  const lastSent = Math.max(
    Number((event.user.app_metadata || {}).confirmation_resent_at || 0),
    Date.parse(event.user.created_at || "") || 0
  );
  if (Date.now() - lastSent < RESEND_INTERVAL_MS) return;
  try {
    const client = await management(event, api);
    await client.jobs.verificationEmail.create({ user_id: event.user.user_id });
    api.user.setAppMetadata("confirmation_resent_at", Date.now());
  } catch (error) {
    console.log("verification resend failed: " + (error && error.message));
  }
}

exports.onExecutePostLogin = async (event, api) => {
  // An address nobody has proved they own is not an identity, so an
  // unconfirmed sign-in is refused here, at the source, rather than being
  // allowed to claim someone else's account.
  //
  // A refusal with nothing behind it is a dead end, so a password account is
  // sent a fresh link - but not on top of the one Auth0 sends at sign-up, and
  // not on every retry (#428). A social provider confirms its own addresses,
  // so a link from us cannot help there, and its refusal says so.
  if (event.user.email_verified !== true) {
    if (!event.user.email) {
      api.access.deny("This sign-in has no email address on it. Letter IRL needs one to open an account.");
      return;
    }
    if (event.connection.strategy === "auth0") {
      await resendConfirmation(event, api);
      api.access.deny(
        "We've sent a confirmation link to your email address - check your spam " +
        "folder if it's not in your inbox. Open the link, then sign in again. " +
        "If nothing arrives within 10 minutes, sign in again for a new link."
      );
    } else {
      api.access.deny(
        "The service you signed in with hasn't confirmed this email address. " +
        "Confirm it there, or sign in with email and password, then try again."
      );
    }
    return;
  }

  try {
    const client = await management(event, api);

    const matches = await client.users.listUsersByEmail({ email: event.user.email });

    // Only confirmed addresses, and only other accounts.
    const others = (matches || []).filter(
      user => user.email_verified === true && user.user_id !== event.user.user_id
    );
    if (others.length === 0) return;

    // The oldest account survives: it is the one with the history.
    const primary = others
      .concat(event.user)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
    if (primary.user_id === event.user.user_id) return;

    // Link first, THEN setPrimaryUser: the identity that authenticated this
    // login has to already be a secondary of the primary user.
    const separator = event.user.user_id.indexOf("|");
    await client.users.identities.link(primary.user_id, {
      provider: event.user.user_id.slice(0, separator),
      user_id: event.user.user_id.slice(separator + 1)
    });
    api.authentication.setPrimaryUser(primary.user_id);
  } catch (error) {
    // Deny rather than let a second account be created. A denied login is
    // recoverable in a minute; a split account is not recoverable at all
    // without an operator merging two histories by hand.
    console.log("link-verified-email failed: " + (error && error.message));
    api.access.deny("Sign-in is temporarily unavailable. Please try again.");
  }
};

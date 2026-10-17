exports.onExecutePostLogin = async (event, api) => {
  if (!event.user.email || event.user.email_verified !== true) return;
  api.accessToken.setCustomClaim("https://letterirl.com/email", event.user.email);
  api.accessToken.setCustomClaim("https://letterirl.com/email_verified", true);
};

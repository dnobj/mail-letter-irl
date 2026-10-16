/**
 * The message validateJWTToken throws when the server cannot validate any
 * token: no issuer or JWKS URL, or other than exactly one configured audience.
 *
 * Every caller that answers it with 503 compares against this constant. They
 * used to compare against their own copies of the literal, so rewording the
 * throw would have quietly sent any caller whose tests mock the validator back
 * to a 401 - on MCP, a challenge that loops the client through authorization.
 */
export const OAUTH_NOT_CONFIGURED = "OAuth validation not configured";

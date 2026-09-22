import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import { getProfileInputSchema, getProfileOutputSchema } from "../schemas.js";
import { findUser } from "../services/userService.js";

/**
 * The profile ChatGPT records for a connected account.
 *
 * OpenAI's Plugins auth guidance: an authenticated, read-only tool that takes
 * an empty argument object and returns, in structuredContent, an `id` that is
 * "unique within your app" and "must retain its ID across token refresh,
 * reconnection, and scope upgrades", plus optional display fields. The tool
 * is found by its `_meta["openai/profile"]` marker, not by name or position;
 * ChatGPT calls it with the connection's credentials when it needs to
 * identify the account - at link time, before any conversation.
 *
 * Why this exists (#424): since ChatGPT's multiple-accounts-per-connector
 * rollout on 2026-09-17, connecting failed at ChatGPT's own callback with
 * OAUTH_OWNER_PROFILE_ID_MISSING, after a successful Auth0 login and code
 * exchange and with this server never called. Every scope-side lever was
 * tried and read back from the Auth0 grant: none changed what ChatGPT
 * requested. The docs call this tool optional; the error names a profile id.
 */
export interface GetProfileOutput {
  /**
   * The account's own key: `users.user_id`. It is the surviving primary
   * subject once sign-in methods are linked (docs/auth0-tenant-configuration.md),
   * so it does not change when a second method is added, and it is never
   * reassigned - a deleted account's subject is not reused by Auth0.
   */
  id: string;
  /** The confirmed address the account is opened on. */
  email?: string;
}

async function handler(
  _input: Record<string, never>,
  context: ToolContext
): Promise<GetProfileOutput> {
  const userId = context.user.userId;

  // The account row is opened before any tool runs (prepareAuthenticatedUser
  // in registerTools), so a missing row here is a fault, and the guidance is
  // explicit about what to do with one: "return the appropriate auth error
  // instead of a placeholder ID or another account's profile". No invented
  // identity, no fallback.
  const user = await findUser(userId);
  if (!user) {
    throw new Error("No account is open for this sign-in.");
  }

  context.logger.info(
    { correlationId: context.correlationId, event: "profile.lookup" },
    "Returned the account profile"
  );

  return {
    id: user.user_id,
    ...(user.email ? { email: user.email } : {})
  };
}

export const getProfileTool: McpToolDefinition<Record<string, never>, GetProfileOutput> = {
  name: "get_profile",
  title: "Profile",
  // Read by the model every turn, so it says what the tool is for and no more.
  description:
    "Identifies the connected Letter IRL account: a stable account id and the account's email address. Read-only.",
  readOnly: true,
  inputSchema: getProfileInputSchema,
  outputSchema: getProfileOutputSchema,
  meta: {
    // The marker ChatGPT discovers the profile tool by. It "does not enable
    // the feature or grant eligibility"; it says which tool answers.
    "openai/profile": true,
    "openai/toolInvocation/invoking": "Checking account…",
    "openai/toolInvocation/invoked": "Account identified",
    readOnlyHint: true
  },
  handler
};

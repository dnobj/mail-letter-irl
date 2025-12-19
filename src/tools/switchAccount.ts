import { McpToolDefinition, ToolContext } from "../contracts/types.js";

interface SwitchAccountOutput {
  logoutUrl: string;
  instructions: string;
  availableAuthMethods: string[];
}

const OUTPUT_TEMPLATE = "text";

async function handler(
  _input: Record<string, never>,
  context: ToolContext
): Promise<SwitchAccountOutput> {
  const issuer = process.env.LETTER_IRL_OAUTH_ISSUER || 'https://dev-ky21dxn3qmi71hjl.us.auth0.com/';
  const publicBaseUrl = process.env.LETTER_IRL_PUBLIC_BASE_URL || 'http://localhost:8788';

  const logoutUrl = `${issuer}v2/logout?returnTo=${encodeURIComponent(publicBaseUrl)}`;

  const availableAuthMethods = [
    'Google',
    'Microsoft',
    'Apple',
    'GitHub',
    'Email/Password'
  ];

  const instructions =
    'To switch to a different account:\n\n' +
    '1. Click the logout link below to end your current session\n' +
    '2. Reconnect to Letter IRL in ChatGPT\n' +
    '3. Choose your preferred authentication method from the options\n\n' +
    `Logout URL: ${logoutUrl}`;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "account.switch.requested",
      userId: context.user.userId
    },
    "User requested account switch"
  );

  return {
    logoutUrl,
    instructions,
    availableAuthMethods
  };
}

export const switchAccountTool: McpToolDefinition<
  Record<string, never>,
  SwitchAccountOutput
> = {
  name: "switch_account",
  description: "Log out and switch to a different account or authentication method (Google, Microsoft, Apple, GitHub, or Email/Password).",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  },
  outputSchema: {
    type: "object",
    properties: {
      logoutUrl: { type: "string" },
      instructions: { type: "string" },
      availableAuthMethods: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["logoutUrl", "instructions", "availableAuthMethods"]
  },
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Preparing account switch…",
    "openai/toolInvocation/invoked": "Switch account instructions ready",
    readOnlyHint: true
  },
  handler
};

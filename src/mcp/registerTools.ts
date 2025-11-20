import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LetterIrlServer } from "../server.js";
import { toolInputSchemas } from "./toolSchemas.js";
import {
  quoteAndPreviewInputZ,
  sendLetterInputZ,
  getOrderStatusInputZ,
  getAccountBalanceInputZ,
  listOrdersInputZ
} from "../zodSchemas.js";
import { AuthenticatedUser } from "../auth/tokenValidator.js";
import { getOrCreateUser } from "../services/userService.js";

type ToolName = keyof typeof toolInputSchemas;

const DEFAULT_USER_ID = process.env.LETTER_IRL_DEFAULT_USER_ID ?? "mcp-user";

const zodInputSchemas: Record<ToolName, z.ZodObject<any>> = {
  quote_and_preview_letter: quoteAndPreviewInputZ,
  send_letter: sendLetterInputZ,
  get_order_status: getOrderStatusInputZ,
  get_account_balance: getAccountBalanceInputZ,
  list_orders: listOrdersInputZ
};

function getZodShape(name: string) {
  const schema = zodInputSchemas[name as ToolName];
  return schema?.shape;
}

export async function registerLetterTools(
  mcpServer: McpServer,
  appServer: LetterIrlServer,
  authInfo: AuthenticatedUser | null = null
) {
  const userId = authInfo?.userId ?? DEFAULT_USER_ID;
  console.log(`Registering Letter IRL tools for user: ${userId}`);

  // Auto-create user if they don't exist (with email from Auth0 userinfo endpoint)
  if (authInfo) {
    let email = (authInfo.claims.email as string) || null;

    // If email not in JWT claims, fetch it from Auth0 userinfo endpoint
    if (!email) {
      try {
        const issuer = process.env.LETTER_IRL_OAUTH_ISSUER;
        if (issuer) {
          const userinfoUrl = `${issuer}userinfo`;
          console.log(`🔍 Fetching user info from: ${userinfoUrl}`);

          const response = await fetch(userinfoUrl, {
            headers: {
              'Authorization': `Bearer ${authInfo.token}`
            }
          });

          if (response.ok) {
            const userInfo = await response.json();
            email = userInfo.email || userInfo.sub || 'unknown@example.com';
            console.log(`✅ Retrieved email from userinfo: ${email}`);
          } else {
            console.warn(`⚠️  Failed to fetch userinfo: ${response.status} ${response.statusText}`);
            email = 'unknown@example.com';
          }
        } else {
          email = 'unknown@example.com';
        }
      } catch (error) {
        console.error(`⚠️  Error fetching userinfo:`, error);
        email = 'unknown@example.com';
      }
    }

    try {
      await getOrCreateUser(userId, email);
      console.log(`✅ User ready: ${userId} (${email})`);
    } catch (error) {
      console.error(`⚠️  Failed to create user ${userId}:`, error);
    }
  }

  const toolDefs = appServer.listTools();
  for (const tool of toolDefs) {
    const shape = getZodShape(tool.name);
    if (!shape) {
      continue;
    }

    mcpServer.tool(tool.name, shape, async (args, extra) => {
      console.log(
        `Tool request ${tool.name} payload: ${JSON.stringify(args)} for user: ${userId}`
      );
      const { result, meta } = await appServer.execute({
        toolName: tool.name,
        input: args,
        userId
      });

      const summaryText = summarizeToolResult(tool.name, result as Record<string, unknown>);

      return {
        content: [
          {
            type: "text" as const,
            text: summaryText
          }
        ],
        structuredContent: {
          ...result,
          _meta: meta
        }
      };
    });
  }

}

function summarizeToolResult(
  toolName: string,
  result: Record<string, unknown>
): string {
  switch (toolName) {
    case "get_account_balance": {
      const message = result.message as string;
      return message || `Balance: ${result.creditsRemaining ?? "unknown"} credits`;
    }
    case "quote_and_preview_letter": {
      const required = result.requiredCredits ?? "?";
      const canSend = result.canSendNow ? "can send now" : "cannot send";
      return `Preview ready: requires ${required} credits (${canSend}).`;
    }
    case "send_letter": {
      const status = result.currentStatus ?? "unknown";
      const order = result.orderId ?? "(no id)";
      return `Letter ${order} queued with status ${status}.`;
    }
    case "get_order_status": {
      const status = result.currentStatus ?? "unknown";
      return `Latest order status: ${status}.`;
    }
    case "list_orders": {
      const orders = result.orders as any[];
      const total = result.total ?? 0;
      return `Found ${orders?.length ?? 0} recent orders (${total} total).`;
    }
    default:
      return JSON.stringify(result);
  }
}

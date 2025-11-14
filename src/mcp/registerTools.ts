import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LetterIrlServer } from "../server.js";
import { toolInputSchemas } from "./toolSchemas.js";
import {
  quoteAndPreviewInputZ,
  sendLetterInputZ,
  getOrderStatusInputZ,
  getAccountBalanceInputZ
} from "../zodSchemas.js";
import { AuthenticatedUser } from "../auth/tokenValidator.js";

type ToolName = keyof typeof toolInputSchemas;

const DEFAULT_USER_ID = process.env.LETTER_IRL_DEFAULT_USER_ID ?? "mcp-user";

const zodInputSchemas: Record<ToolName, z.ZodObject<any>> = {
  quote_and_preview_letter: quoteAndPreviewInputZ,
  send_letter: sendLetterInputZ,
  get_order_status: getOrderStatusInputZ,
  get_account_balance: getAccountBalanceInputZ
};

function getZodShape(name: string) {
  const schema = zodInputSchemas[name as ToolName];
  return schema?.shape;
}

export function registerLetterTools(
  mcpServer: McpServer,
  appServer: LetterIrlServer,
  authInfo: AuthenticatedUser | null = null
) {
  const userId = authInfo?.userId ?? DEFAULT_USER_ID;
  console.log(`Registering Letter IRL tools for user: ${userId}`);

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
      const credits = result.creditsRemaining ?? "unknown";
      const cost = result.standardLetterCostCredits ?? 1;
      return `Balance: ${credits} credits (standard letter costs ${cost}).`;
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
    default:
      return JSON.stringify(result);
  }
}

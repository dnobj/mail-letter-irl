import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import { clearReturnAddress, hasReturnAddress } from "../services/returnAddressService.js";

interface ClearReturnAddressInput {
  confirm: boolean;
}

interface ClearReturnAddressOutput {
  success: boolean;
  message: string;
}

async function handler(
  input: ClearReturnAddressInput,
  context: ToolContext
): Promise<ClearReturnAddressOutput> {
  if (!input.confirm) {
    return {
      success: false,
      message: "Please set confirm: true to clear your return address."
    };
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "return_address.clear"
    },
    "Clearing return address"
  );

  const hadAddress = await hasReturnAddress(context.user.userId);

  if (!hadAddress) {
    return {
      success: true,
      message: "You don't have a saved return address to clear."
    };
  }

  await clearReturnAddress(context.user.userId);

  return {
    success: true,
    message: "Your return address has been cleared. You will need to provide a sender address when creating letters."
  };
}

export const clearReturnAddressTool: McpToolDefinition<
  ClearReturnAddressInput,
  ClearReturnAddressOutput
> = {
  name: "clear_return_address",
  description:
    "Clear your saved return address. After clearing, you will need to provide a sender address " +
    "each time you create a letter.",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      confirm: {
        type: "boolean",
        description: "Set to true to confirm clearing the return address"
      }
    },
    required: ["confirm"]
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      message: { type: "string" }
    }
  },
  meta: {
    "openai/toolInvocation/invoking": "Clearing return address...",
    "openai/toolInvocation/invoked": "Return address cleared",
    // OpenAI Apps SDK annotations
    destructiveHint: true   // Permanently deletes saved return address
  },
  handler
};

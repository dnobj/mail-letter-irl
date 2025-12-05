import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import { getReturnAddress, ReturnAddress } from "../services/returnAddressService.js";

interface GetReturnAddressInput {
  // No input needed
}

interface GetReturnAddressOutput {
  hasAddress: boolean;
  message: string;
  address?: {
    name: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

async function handler(
  input: GetReturnAddressInput,
  context: ToolContext
): Promise<GetReturnAddressOutput> {
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "return_address.get"
    },
    "Getting return address"
  );

  const address = await getReturnAddress(context.user.userId);

  if (!address) {
    return {
      hasAddress: false,
      message: "You don't have a saved return address. Use set_return_address to save one for convenience."
    };
  }

  return {
    hasAddress: true,
    message: `Your saved return address is: ${address.name}, ${address.addressLine1}, ${address.city}, ${address.state} ${address.postalCode}`,
    address
  };
}

export const getReturnAddressTool: McpToolDefinition<
  GetReturnAddressInput,
  GetReturnAddressOutput
> = {
  name: "get_return_address",
  description:
    "Get your saved return address. This is the address that will be automatically used as the sender " +
    "when you create letters without specifying a sender address.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  },
  outputSchema: {
    type: "object",
    properties: {
      hasAddress: { type: "boolean" },
      message: { type: "string" },
      address: { type: "object" }
    }
  },
  meta: {
    "openai/toolInvocation/invoking": "Checking return address...",
    "openai/toolInvocation/invoked": "Return address retrieved",
    readOnlyHint: true
  },
  handler
};

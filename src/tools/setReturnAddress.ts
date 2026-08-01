import { McpToolDefinition, ToolContext, Address } from "../contracts/types.js";
import {
  setReturnAddress,
  ReturnAddress,
  SetReturnAddressResult
} from "../services/returnAddressService.js";

interface SetReturnAddressInput {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
}

interface SetReturnAddressOutput {
  success: boolean;
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
  wasAutoCorrected: boolean;
  correctionDetails?: string;
  errors?: string[];
}

async function handler(
  input: SetReturnAddressInput,
  context: ToolContext
): Promise<SetReturnAddressOutput> {
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "return_address.set.start"
    },
    "Setting return address"
  );

  const address: ReturnAddress = {
    name: input.name,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    country: input.country || 'US'
  };

  const result = await setReturnAddress(context.user.userId, address);

  if (!result.success) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "return_address.set.failed",
        errorClass: "validation_error"
      },
      "Failed to set return address"
    );

    return {
      success: false,
      message: `Could not save return address: ${result.errors?.join('. ') || 'Validation failed'}`,
      wasAutoCorrected: false,
      errors: result.errors
    };
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "return_address.set.success",
      wasAutoCorrected: result.wasAutoCorrected
    },
    "Return address saved successfully"
  );

  let message: string;
  if (result.wasAutoCorrected) {
    message = `Return address saved! Note: The address was auto-corrected for deliverability. ${result.correctionDetails}`;
  } else {
    message = `Return address saved successfully! This address will be used as the default sender for your letters.`;
  }

  return {
    success: true,
    message,
    address: result.address,
    wasAutoCorrected: result.wasAutoCorrected,
    correctionDetails: result.correctionDetails
  };
}

export const setReturnAddressTool: McpToolDefinition<
  SetReturnAddressInput,
  SetReturnAddressOutput
> = {
  name: "set_return_address",
  description:
    "Save your preferred return address for future letters and postcards. The address is validated before saving, corrected when possible, and used automatically when you omit a sender address. U.S. addresses only.",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Your name as it should appear on letters"
      },
      addressLine1: {
        type: "string",
        description: "Street address (e.g., '123 Main Street')"
      },
      addressLine2: {
        type: "string",
        description: "Apartment, suite, unit, etc. (optional)"
      },
      city: {
        type: "string",
        description: "City name"
      },
      state: {
        type: "string",
        description: "State (2-letter code, e.g., 'CA', 'NY')"
      },
      postalCode: {
        type: "string",
        description: "ZIP code (5-digit or ZIP+4)"
      },
      country: {
        type: "string",
        description: "Country (currently only 'US' is supported)",
        default: "US"
      }
    },
    required: ["name", "addressLine1", "city", "state", "postalCode"]
  },
  outputSchema: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      message: { type: "string" },
      address: { type: "object" },
      wasAutoCorrected: { type: "boolean" },
      correctionDetails: { type: "string" },
      errors: { type: "array", items: { type: "string" } }
    }
  },
  meta: {
    "openai/toolInvocation/invoking": "Validating and saving return address...",
    "openai/toolInvocation/invoked": "Return address saved",
    // OpenAI Apps SDK annotations
    openWorldHint: true     // Validates address via PostGrid external API
  },
  handler
};

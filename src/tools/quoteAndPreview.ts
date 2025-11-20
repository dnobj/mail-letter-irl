import { Address, McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  quoteAndPreviewInputSchema,
  quoteAndPreviewOutputSchema
} from "../schemas.js";
import {
  estimateRequiredCredits,
  renderPreviewHtml
} from "../services/previewService.js";
import { getLetterProvider } from "../services/providers/index.js";
import type { AddressValidationInput, AddressValidationResult } from "../services/providers/types.js";

interface QuoteAndPreviewInput {
  sender: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

interface QuoteAndPreviewOutput {
  previewHtml: string;
  requiredCredits: number;
  canSendNow: boolean;
  reasonCannotSend?: string;
  deliveryClass?: string;
  estimatedDeliveryDays?: number;
  // Address validation results
  senderAddressValidation?: {
    status: 'verified' | 'corrected' | 'failed';
    originalAddress: Address;
    verifiedAddress?: Address;
    errors?: string[];
    suggestions?: string;
  };
  recipientAddressValidation?: {
    status: 'verified' | 'corrected' | 'failed';
    originalAddress: Address;
    verifiedAddress?: Address;
    errors?: string[];
    suggestions?: string;
  };
}

const OUTPUT_TEMPLATE = "LetterPreviewCard";

async function handler(
  input: QuoteAndPreviewInput,
  context: ToolContext
): Promise<QuoteAndPreviewOutput> {
  const missingFields = collectMissingAddressFields(input);
  if (missingFields.length > 0) {
    const message = `Missing required address fields: ${missingFields.join(", ")}`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.preview.missing_fields",
        missingFields
      },
      message
    );
    throw new Error(
      `${message}. Please provide full sender and recipient addresses (name, street, city, state, postal code, country).`
    );
  }

  // Normalize country codes to US (2-letter ISO code)
  // Accept: US, USA, United States, us, usa, etc.
  const normalizeCountryToUS = (country?: string): string => {
    if (!country) return 'US';
    const normalized = country.toUpperCase().trim();
    if (normalized === 'US' || normalized === 'USA' || normalized === 'UNITED STATES' || normalized === 'U.S.' || normalized === 'U.S.A.') {
      return 'US';
    }
    return normalized;
  };

  input.sender.country = normalizeCountryToUS(input.sender.country);
  input.recipient.country = normalizeCountryToUS(input.recipient.country);

  // Validate US-only service
  const nonUSAddresses: string[] = [];
  if (input.sender.country !== 'US') {
    nonUSAddresses.push(`sender address is in ${input.sender.country}`);
  }
  if (input.recipient.country !== 'US') {
    nonUSAddresses.push(`recipient address is in ${input.recipient.country}`);
  }

  if (nonUSAddresses.length > 0) {
    const message = `Letter IRL currently only supports mailing within the United States. ${nonUSAddresses.join(', ')}.`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.preview.non_us_address",
        senderCountry: input.sender.country,
        recipientCountry: input.recipient.country
      },
      message
    );
    throw new Error(message);
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.preview.start"
    },
    "Processing quote_and_preview_letter"
  );

  // Validate one-page constraint (~1,800 characters maximum)
  const MAX_CHARS_PER_PAGE = 1800;
  const totalChars = `${input.bodyText}\n\n${input.signOff}`.length;

  if (totalChars > MAX_CHARS_PER_PAGE) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.preview.exceeds_page_limit",
        totalChars,
        maxChars: MAX_CHARS_PER_PAGE
      },
      "Letter exceeds one-page limit"
    );
    throw new Error(
      `Letter exceeds one-page limit (${totalChars}/${MAX_CHARS_PER_PAGE} characters). ` +
      `Please shorten your message to fit on one page. ` +
      `All letters are currently limited to one page maximum.`
    );
  }

  // Validate addresses using provider if available
  const provider = getLetterProvider();
  let senderValidation: AddressValidationResult | undefined;
  let recipientValidation: AddressValidationResult | undefined;

  if (provider.validateAddress) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.preview.validating_addresses"
      },
      "Validating addresses with provider"
    );

    // Validate sender address
    const senderAddressInput: AddressValidationInput = {
      line1: input.sender.addressLine1,
      line2: input.sender.addressLine2,
      city: input.sender.city,
      state: input.sender.state,
      postalCode: input.sender.postalCode,
      country: input.sender.country
    };

    senderValidation = await provider.validateAddress(senderAddressInput);

    // Validate recipient address
    const recipientAddressInput: AddressValidationInput = {
      line1: input.recipient.addressLine1,
      line2: input.recipient.addressLine2,
      city: input.recipient.city,
      state: input.recipient.state,
      postalCode: input.recipient.postalCode,
      country: input.recipient.country
    };

    recipientValidation = await provider.validateAddress(recipientAddressInput);

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.preview.addresses_validated",
        senderStatus: senderValidation.status,
        recipientStatus: recipientValidation.status
      },
      "Address validation complete"
    );

    // Check if addresses need user confirmation (corrected or failed)
    // Only proceed if BOTH addresses are 'verified' (exact match)
    const needsConfirmation = senderValidation.status !== 'verified' || recipientValidation.status !== 'verified';

    if (needsConfirmation) {
      const errorParts: string[] = [];

      // Handle sender address
      if (senderValidation.status === 'failed') {
        const errorMsg = senderValidation.errors?.map(e => e.message).join('; ') || 'Address is invalid or undeliverable';
        errorParts.push(`❌ Sender address is INVALID: ${errorMsg}`);

        if (senderValidation.verifiedAddress) {
          errorParts.push(
            `   Suggested correction:\n` +
            `   ${senderValidation.verifiedAddress.line1}\n` +
            `   ${senderValidation.verifiedAddress.line2 ? senderValidation.verifiedAddress.line2 + '\n   ' : ''}` +
            `   ${senderValidation.verifiedAddress.city}, ${senderValidation.verifiedAddress.state} ${senderValidation.verifiedAddress.postalCode}`
          );
        }
      } else if (senderValidation.status === 'corrected') {
        errorParts.push(`⚠️  Sender address was AUTO-CORRECTED for deliverability:`);
        errorParts.push(`   Original: ${input.sender.addressLine1}, ${input.sender.city}, ${input.sender.state} ${input.sender.postalCode}`);
        if (senderValidation.verifiedAddress) {
          errorParts.push(
            `   Corrected: ${senderValidation.verifiedAddress.line1}, ` +
            `${senderValidation.verifiedAddress.city}, ${senderValidation.verifiedAddress.state} ${senderValidation.verifiedAddress.postalCode}`
          );
        }
      }

      // Handle recipient address
      if (recipientValidation.status === 'failed') {
        const errorMsg = recipientValidation.errors?.map(e => e.message).join('; ') || 'Address is invalid or undeliverable';
        errorParts.push(`❌ Recipient address is INVALID: ${errorMsg}`);

        if (recipientValidation.verifiedAddress) {
          errorParts.push(
            `   Suggested correction:\n` +
            `   ${recipientValidation.verifiedAddress.line1}\n` +
            `   ${recipientValidation.verifiedAddress.line2 ? recipientValidation.verifiedAddress.line2 + '\n   ' : ''}` +
            `   ${recipientValidation.verifiedAddress.city}, ${recipientValidation.verifiedAddress.state} ${recipientValidation.verifiedAddress.postalCode}`
          );
        }
      } else if (recipientValidation.status === 'corrected') {
        errorParts.push(`⚠️  Recipient address was AUTO-CORRECTED for deliverability:`);
        errorParts.push(`   Original: ${input.recipient.addressLine1}, ${input.recipient.city}, ${input.recipient.state} ${input.recipient.postalCode}`);
        if (recipientValidation.verifiedAddress) {
          errorParts.push(
            `   Corrected: ${recipientValidation.verifiedAddress.line1}, ` +
            `${recipientValidation.verifiedAddress.city}, ${recipientValidation.verifiedAddress.state} ${recipientValidation.verifiedAddress.postalCode}`
          );
        }
      }

      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.preview.address_needs_confirmation",
          senderStatus: senderValidation.status,
          recipientStatus: recipientValidation.status
        },
        "Address validation requires user confirmation"
      );

      const hasFailures = senderValidation.status === 'failed' || recipientValidation.status === 'failed';
      const actionMsg = hasFailures
        ? `Please correct the invalid address(es) and try again.`
        : `Please resubmit using the corrected address(es) shown above to proceed.`;

      throw new Error(
        `Address validation requires confirmation:\n\n${errorParts.join('\n\n')}\n\n${actionMsg}`
      );
    }
  }

  const requiredCredits = estimateRequiredCredits(input.bodyText, input.signOff);
  const available = context.user.creditsRemaining;
  const canSendNow = available >= requiredCredits;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.preview.computed",
      availableCredits: available,
      requiredCredits,
      canSendNow
    },
    "Computed preview requirements"
  );

  // Build response
  const output: QuoteAndPreviewOutput = {
    previewHtml: renderPreviewHtml(input),
    requiredCredits,
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : "Insufficient Letter IRL credits.",
    deliveryClass: "First Class Letter",
    estimatedDeliveryDays: 5
  };

  // Add address validation results if available
  if (senderValidation) {
    output.senderAddressValidation = {
      status: senderValidation.status,
      originalAddress: input.sender,
      verifiedAddress: senderValidation.verifiedAddress ? {
        name: input.sender.name,
        addressLine1: senderValidation.verifiedAddress.line1,
        addressLine2: senderValidation.verifiedAddress.line2,
        city: senderValidation.verifiedAddress.city,
        state: senderValidation.verifiedAddress.state,
        postalCode: senderValidation.verifiedAddress.postalCode,
        country: senderValidation.verifiedAddress.country
      } : undefined,
      errors: senderValidation.errors?.map(e => e.message),
      suggestions: senderValidation.status === 'corrected'
        ? `Address was corrected: ${senderValidation.verifiedAddress?.line1}, ${senderValidation.verifiedAddress?.city}, ${senderValidation.verifiedAddress?.state} ${senderValidation.verifiedAddress?.postalCode}`
        : undefined
    };
  }

  if (recipientValidation) {
    output.recipientAddressValidation = {
      status: recipientValidation.status,
      originalAddress: input.recipient,
      verifiedAddress: recipientValidation.verifiedAddress ? {
        name: input.recipient.name,
        addressLine1: recipientValidation.verifiedAddress.line1,
        addressLine2: recipientValidation.verifiedAddress.line2,
        city: recipientValidation.verifiedAddress.city,
        state: recipientValidation.verifiedAddress.state,
        postalCode: recipientValidation.verifiedAddress.postalCode,
        country: recipientValidation.verifiedAddress.country
      } : undefined,
      errors: recipientValidation.errors?.map(e => e.message),
      suggestions: recipientValidation.status === 'corrected'
        ? `Address was corrected: ${recipientValidation.verifiedAddress?.line1}, ${recipientValidation.verifiedAddress?.city}, ${recipientValidation.verifiedAddress?.state} ${recipientValidation.verifiedAddress?.postalCode}`
        : undefined
    };
  }

  return output;
}

export const quoteAndPreviewLetterTool: McpToolDefinition<
  QuoteAndPreviewInput,
  QuoteAndPreviewOutput
> = {
  name: "quote_and_preview_letter",
  description:
    "Generate a preview and cost estimate for a letter. Validates addresses and only returns preview if addresses are verified.\n\n" +
    "IMPORTANT - Address Validation Workflow:\n" +
    "1. This tool automatically validates all addresses for deliverability (US only).\n" +
    "2. If validation returns an error with 'AUTO-CORRECTED' addresses, YOU MUST:\n" +
    "   - Show the user BOTH the original and corrected addresses\n" +
    "   - Ask the user to confirm they want to use the corrected addresses\n" +
    "   - If user confirms, call this tool AGAIN with the EXACT corrected addresses shown\n" +
    "3. Only when addresses are verified as exact matches will you receive a preview with canSendNow: true.\n" +
    "4. Do NOT proceed to send_letter without getting a successful preview first.\n\n" +
    "Service Restrictions:\n" +
    "- US addresses only (both sender and recipient must be in USA)\n" +
    "- Maximum 1 page (~1,800 characters total for body + sign-off)",
  readOnly: true,
  inputSchema: quoteAndPreviewInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/toolInvocation/invoking": "Generating preview…",
    "openai/toolInvocation/invoked": "Preview ready",
    readOnlyHint: true
  },
  handler
};

const REQUIRED_ADDRESS_PROPS = [
  "name",
  "addressLine1",
  "city",
  "state",
  // postalCode is optional - PostGrid can suggest it via address validation
  "country"
];

function collectMissingAddressFields(input: QuoteAndPreviewInput): string[] {
  const missing: string[] = [];
  for (const [label, block] of [
    ["sender", input.sender],
    ["recipient", input.recipient]
  ] as const) {
    if (!block) {
      missing.push(`${label}`);
      continue;
    }
    for (const prop of REQUIRED_ADDRESS_PROPS) {
      if (!block[prop as keyof Address]) {
        missing.push(`${label}.${prop}`);
      }
    }
  }
  return missing;
}

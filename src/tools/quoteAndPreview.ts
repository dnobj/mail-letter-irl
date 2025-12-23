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
import { createDraft } from "../services/draftService.js";
import { getReturnAddress } from "../services/returnAddressService.js";

interface QuoteAndPreviewInput {
  sender?: Address;  // Optional - will use saved return address if not provided
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
  // Draft for idempotent send
  draftId: string;
  draftExpiresAt: string;  // ISO timestamp
  // Saved return address used (when sender not provided)
  usedSavedReturnAddress?: boolean;
  savedReturnAddressNote?: string;
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

const OUTPUT_TEMPLATE = "ui://widgets/LetterPreviewCard.html";

async function handler(
  input: QuoteAndPreviewInput,
  context: ToolContext
): Promise<QuoteAndPreviewOutput> {
  // Track if we used the saved return address
  let usedSavedReturnAddress = false;
  let savedReturnAddressNote: string | undefined;

  // If sender not provided, try to use saved return address
  if (!input.sender) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.preview.sender_not_provided"
      },
      "Sender not provided, checking for saved return address"
    );

    const savedAddress = await getReturnAddress(context.user.userId);

    if (savedAddress) {
      // Use the saved return address
      input.sender = savedAddress;
      usedSavedReturnAddress = true;
      savedReturnAddressNote = `Using your saved return address: ${savedAddress.name}, ${savedAddress.addressLine1}, ${savedAddress.city}, ${savedAddress.state} ${savedAddress.postalCode}`;

      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.using_saved_address",
          savedAddressCity: savedAddress.city,
          savedAddressState: savedAddress.state
        },
        "Using saved return address for sender"
      );
    } else {
      // No saved address and no sender provided - throw helpful error
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.preview.no_sender_address"
        },
        "No sender address provided and no saved return address"
      );
      throw new Error(
        "No return address provided. Please either:\n" +
        "1. Include a sender address in your request, or\n" +
        "2. Save a return address using the set_return_address tool first.\n\n" +
        "You can set a return address once and it will be used automatically for all future letters."
      );
    }
  }

  // At this point, sender is guaranteed to exist (either provided or from saved address)
  const sender = input.sender as Address;

  const missingFields = collectMissingAddressFields({ sender, recipient: input.recipient, bodyText: input.bodyText, signOff: input.signOff });
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

  sender.country = normalizeCountryToUS(sender.country);
  input.recipient.country = normalizeCountryToUS(input.recipient.country);

  // Validate US-only service
  const nonUSAddresses: string[] = [];
  if (sender.country !== 'US') {
    nonUSAddresses.push(`sender address is in ${sender.country}`);
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
        senderCountry: sender.country,
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
      line1: sender.addressLine1,
      line2: sender.addressLine2,
      city: sender.city,
      state: sender.state,
      postalCode: sender.postalCode,
      country: sender.country
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

    // Check if any addresses failed validation (truly invalid/undeliverable)
    // Corrected addresses are auto-accepted to avoid unnecessary re-submission (US-EDGE-02)
    const hasFailures = senderValidation.status === 'failed' || recipientValidation.status === 'failed';

    if (hasFailures) {
      const errorParts: string[] = [];

      // Handle failed sender address
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
      }

      // Handle failed recipient address
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
      }

      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.preview.address_validation_failed",
          senderStatus: senderValidation.status,
          recipientStatus: recipientValidation.status
        },
        "Address validation failed - invalid addresses"
      );

      throw new Error(
        `Address validation failed:\n\n${errorParts.join('\n\n')}\n\nPlease correct the invalid address(es) and try again.`
      );
    }

    // For corrected addresses, auto-apply the correction to the preview/draft
    // This avoids requiring re-submission for minor corrections (ZIP+4, formatting, etc.)
    if (senderValidation.status === 'corrected' && senderValidation.verifiedAddress) {
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.sender_address_corrected",
          original: `${sender.addressLine1}, ${sender.city}, ${sender.state} ${sender.postalCode}`,
          corrected: `${senderValidation.verifiedAddress.line1}, ${senderValidation.verifiedAddress.city}, ${senderValidation.verifiedAddress.state} ${senderValidation.verifiedAddress.postalCode}`
        },
        "Auto-applying corrected sender address"
      );

      // Update sender with corrected address (this is what will be mailed)
      sender.addressLine1 = senderValidation.verifiedAddress.line1;
      sender.addressLine2 = senderValidation.verifiedAddress.line2;
      sender.city = senderValidation.verifiedAddress.city;
      sender.state = senderValidation.verifiedAddress.state;
      sender.postalCode = senderValidation.verifiedAddress.postalCode;
      if (senderValidation.verifiedAddress.country) {
        sender.country = senderValidation.verifiedAddress.country;
      }
    }

    if (recipientValidation.status === 'corrected' && recipientValidation.verifiedAddress) {
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.preview.recipient_address_corrected",
          original: `${input.recipient.addressLine1}, ${input.recipient.city}, ${input.recipient.state} ${input.recipient.postalCode}`,
          corrected: `${recipientValidation.verifiedAddress.line1}, ${recipientValidation.verifiedAddress.city}, ${recipientValidation.verifiedAddress.state} ${recipientValidation.verifiedAddress.postalCode}`
        },
        "Auto-applying corrected recipient address"
      );

      // Update recipient with corrected address (this is what will be mailed)
      input.recipient.addressLine1 = recipientValidation.verifiedAddress.line1;
      input.recipient.addressLine2 = recipientValidation.verifiedAddress.line2;
      input.recipient.city = recipientValidation.verifiedAddress.city;
      input.recipient.state = recipientValidation.verifiedAddress.state;
      input.recipient.postalCode = recipientValidation.verifiedAddress.postalCode;
      if (recipientValidation.verifiedAddress.country) {
        input.recipient.country = recipientValidation.verifiedAddress.country;
      }
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

  // Generate preview HTML
  const previewHtml = renderPreviewHtml({ sender, recipient: input.recipient, bodyText: input.bodyText, signOff: input.signOff });

  // Create draft for idempotent send
  const draftResult = await createDraft({
    userId: context.user.userId,
    sender: sender as unknown as Record<string, unknown>,
    recipient: input.recipient as unknown as Record<string, unknown>,
    bodyText: input.bodyText,
    signOff: input.signOff,
    requiredCredits,
    previewHtml,
    senderValidation: senderValidation ? { status: senderValidation.status } : undefined,
    recipientValidation: recipientValidation ? { status: recipientValidation.status } : undefined,
  });

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.preview.draft_created",
      draftId: draftResult.draftId,
      expiresAt: draftResult.expiresAt.toISOString()
    },
    "Draft created for idempotent send"
  );

  // Build response
  const output: QuoteAndPreviewOutput = {
    previewHtml,
    requiredCredits,
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : "Insufficient Letter IRL credits.",
    deliveryClass: "First Class Letter",
    estimatedDeliveryDays: 5,
    draftId: draftResult.draftId,
    draftExpiresAt: draftResult.expiresAt.toISOString(),
    // Include saved return address info if used
    usedSavedReturnAddress: usedSavedReturnAddress || undefined,
    savedReturnAddressNote: savedReturnAddressNote,
  };

  // Add address validation results if available
  if (senderValidation) {
    output.senderAddressValidation = {
      status: senderValidation.status,
      originalAddress: sender,
      verifiedAddress: senderValidation.verifiedAddress ? {
        name: sender.name,
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
    "Generate a preview and cost estimate for a letter. Validates addresses and creates a draft for sending.\n\n" +
    "IMPORTANT - Sender Address:\n" +
    "- If you don't provide a sender address, your saved return address will be used automatically.\n" +
    "- If you have no saved return address and don't provide one, you'll be prompted to set one.\n" +
    "- Use set_return_address to save a return address that will be used for all future letters.\n\n" +
    "IMPORTANT - Draft Workflow:\n" +
    "1. This tool validates addresses and creates a DRAFT with a unique draftId.\n" +
    "2. The draftId is REQUIRED when calling send_letter - you cannot send without it.\n" +
    "3. Each draft expires after 24 hours if not sent.\n" +
    "4. Using the draftId ensures idempotent sends - retrying send_letter with the same draftId will not charge twice.\n\n" +
    "Address Validation:\n" +
    "- Addresses are automatically validated for deliverability (US only).\n" +
    "- Minor corrections (ZIP+4, formatting) are auto-applied - no re-submission needed.\n" +
    "- The response shows both original and corrected addresses when corrections are made.\n" +
    "- Only truly invalid addresses (not found, undeliverable) will return an error.\n\n" +
    "Service Restrictions:\n" +
    "- US addresses only (both sender and recipient must be in USA)\n" +
    "- Maximum 1 page (~1,800 characters total for body + sign-off)",
  readOnly: true,
  inputSchema: quoteAndPreviewInputSchema,
  outputSchema: quoteAndPreviewOutputSchema,
  meta: {
    "openai/outputTemplate": OUTPUT_TEMPLATE,
    "openai/widgetAccessible": true,
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

interface ResolvedInput {
  sender: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

function collectMissingAddressFields(input: ResolvedInput): string[] {
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

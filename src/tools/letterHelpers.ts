/**
 * Letter Tool Helpers
 *
 * Shared helper functions for the three letter quote/preview tools:
 * - quoteAndPreviewLetterTextOnly
 * - quoteAndPreviewLetterWithHeaderImage
 * - quoteAndPreviewLetterWithImage
 */

import { Address, ToolContext, LetterLayoutType } from "../contracts/types.js";
import { getReturnAddress } from "../services/returnAddressService.js";
import { getLetterProvider } from "../services/providers/index.js";
import type { AddressValidationInput, AddressValidationResult } from "../services/providers/types.js";
import {
  estimateRequiredCredits,
  renderLayoutPreviewHtml,
  validateCharacterLimit,
} from "../services/previewService.js";
import { createDraft } from "../services/draftService.js";

// ============================================================================
// Types
// ============================================================================

export interface LetterInput {
  sender?: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
}

export interface PreparedSender {
  sender: Address;
  usedSavedReturnAddress: boolean;
  savedReturnAddressNote?: string;
}

export interface ValidationResults {
  senderValidation?: AddressValidationResult;
  recipientValidation?: AddressValidationResult;
}

export interface LetterQuoteOutput {
  previewHtml: string;
  lettersRequired: number;
  canSendNow: boolean;
  reasonCannotSend?: string;
  deliveryClass: string;
  estimatedDeliveryDays: number;
  draftId: string;
  draftExpiresAt: string;
  layoutType: LetterLayoutType;
  headerImageData?: string;
  inlineImageData?: string;
  usedSavedReturnAddress?: boolean;
  savedReturnAddressNote?: string;
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

// ============================================================================
// Address Helpers
// ============================================================================

const REQUIRED_ADDRESS_PROPS = [
  "name",
  "addressLine1",
  "city",
  "state",
  "country"
];

/**
 * Normalize country codes to US (2-letter ISO code)
 * Accept: US, USA, United States, us, usa, etc.
 */
export function normalizeCountryToUS(country?: string): string {
  if (!country) return 'US';
  const normalized = country.toUpperCase().trim();
  if (normalized === 'US' || normalized === 'USA' || normalized === 'UNITED STATES' || normalized === 'U.S.' || normalized === 'U.S.A.') {
    return 'US';
  }
  return normalized;
}

/**
 * Check for missing required address fields
 */
export function collectMissingAddressFields(sender: Address, recipient: Address): string[] {
  const missing: string[] = [];
  for (const [label, block] of [
    ["sender", sender],
    ["recipient", recipient]
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

/**
 * Validate that both addresses are in the US
 */
export function validateUSOnly(sender: Address, recipient: Address, context: ToolContext): void {
  const nonUSAddresses: string[] = [];
  if (sender.country !== 'US') {
    nonUSAddresses.push(`sender address is in ${sender.country}`);
  }
  if (recipient.country !== 'US') {
    nonUSAddresses.push(`recipient address is in ${recipient.country}`);
  }

  if (nonUSAddresses.length > 0) {
    const message = `Letter IRL currently only supports mailing within the United States. ${nonUSAddresses.join(', ')}.`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.non_us_address",
        senderCountry: sender.country,
        recipientCountry: recipient.country
      },
      message
    );
    throw new Error(message);
  }
}

/**
 * Prepare sender address - use provided or saved return address
 */
export async function prepareSender(
  input: LetterInput,
  context: ToolContext
): Promise<PreparedSender> {
  let usedSavedReturnAddress = false;
  let savedReturnAddressNote: string | undefined;
  let sender: Address;

  if (!input.sender) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.sender_not_provided"
      },
      "Sender not provided, checking for saved return address"
    );

    const savedAddress = await getReturnAddress(context.user.userId);

    if (savedAddress) {
      sender = savedAddress;
      usedSavedReturnAddress = true;
      savedReturnAddressNote = `Using your saved return address: ${savedAddress.name}, ${savedAddress.addressLine1}, ${savedAddress.city}, ${savedAddress.state} ${savedAddress.postalCode}`;

      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.letter.using_saved_address",
          savedAddressCity: savedAddress.city,
          savedAddressState: savedAddress.state
        },
        "Using saved return address for sender"
      );
    } else {
      context.logger.warn(
        {
          correlationId: context.correlationId,
          event: "quote.letter.no_sender_address"
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
  } else {
    sender = input.sender;
  }

  return { sender, usedSavedReturnAddress, savedReturnAddressNote };
}

/**
 * Validate addresses and normalize them
 */
export function validateAddresses(
  sender: Address,
  recipient: Address,
  context: ToolContext
): void {
  // Check for missing fields
  const missingFields = collectMissingAddressFields(sender, recipient);
  if (missingFields.length > 0) {
    const message = `Missing required address fields: ${missingFields.join(", ")}`;
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.missing_fields",
        missingFields
      },
      message
    );
    throw new Error(
      `${message}. Please provide full sender and recipient addresses (name, street, city, state, postal code, country).`
    );
  }

  // Normalize country codes
  sender.country = normalizeCountryToUS(sender.country);
  recipient.country = normalizeCountryToUS(recipient.country);

  // Validate US-only
  validateUSOnly(sender, recipient, context);
}

/**
 * Validate addresses with PostGrid provider and apply corrections
 */
export async function validateAddressesWithProvider(
  sender: Address,
  recipient: Address,
  context: ToolContext
): Promise<ValidationResults> {
  const provider = getLetterProvider();
  let senderValidation: AddressValidationResult | undefined;
  let recipientValidation: AddressValidationResult | undefined;

  if (provider.validateAddress) {
    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.validating_addresses"
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
      line1: recipient.addressLine1,
      line2: recipient.addressLine2,
      city: recipient.city,
      state: recipient.state,
      postalCode: recipient.postalCode,
      country: recipient.country
    };

    recipientValidation = await provider.validateAddress(recipientAddressInput);

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "quote.letter.addresses_validated",
        senderStatus: senderValidation.status,
        recipientStatus: recipientValidation.status
      },
      "Address validation complete"
    );

    // Check for failures
    const hasFailures = senderValidation.status === 'failed' || recipientValidation.status === 'failed';

    if (hasFailures) {
      const errorParts: string[] = [];

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
          event: "quote.letter.address_validation_failed",
          senderStatus: senderValidation.status,
          recipientStatus: recipientValidation.status
        },
        "Address validation failed - invalid addresses"
      );

      throw new Error(
        `Address validation failed:\n\n${errorParts.join('\n\n')}\n\nPlease correct the invalid address(es) and try again.`
      );
    }

    // Auto-apply corrections
    if (senderValidation.status === 'corrected' && senderValidation.verifiedAddress) {
      context.logger.info(
        {
          correlationId: context.correlationId,
          event: "quote.letter.sender_address_corrected",
          original: `${sender.addressLine1}, ${sender.city}, ${sender.state} ${sender.postalCode}`,
          corrected: `${senderValidation.verifiedAddress.line1}, ${senderValidation.verifiedAddress.city}, ${senderValidation.verifiedAddress.state} ${senderValidation.verifiedAddress.postalCode}`
        },
        "Auto-applying corrected sender address"
      );

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
          event: "quote.letter.recipient_address_corrected",
          original: `${recipient.addressLine1}, ${recipient.city}, ${recipient.state} ${recipient.postalCode}`,
          corrected: `${recipientValidation.verifiedAddress.line1}, ${recipientValidation.verifiedAddress.city}, ${recipientValidation.verifiedAddress.state} ${recipientValidation.verifiedAddress.postalCode}`
        },
        "Auto-applying corrected recipient address"
      );

      recipient.addressLine1 = recipientValidation.verifiedAddress.line1;
      recipient.addressLine2 = recipientValidation.verifiedAddress.line2;
      recipient.city = recipientValidation.verifiedAddress.city;
      recipient.state = recipientValidation.verifiedAddress.state;
      recipient.postalCode = recipientValidation.verifiedAddress.postalCode;
      if (recipientValidation.verifiedAddress.country) {
        recipient.country = recipientValidation.verifiedAddress.country;
      }
    }
  }

  return { senderValidation, recipientValidation };
}

// ============================================================================
// Character Limit Validation
// ============================================================================

export function validateCharacterLimitForLayout(
  bodyText: string,
  signOff: string,
  layoutType: LetterLayoutType,
  context: ToolContext
): void {
  const charValidation = validateCharacterLimit(bodyText, signOff, layoutType);

  if (!charValidation.isValid) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "quote.letter.exceeds_page_limit",
        layoutType,
        totalChars: charValidation.totalChars,
        maxChars: charValidation.limit
      },
      "Letter exceeds one-page limit"
    );
    throw new Error(
      `${charValidation.error} (${charValidation.totalChars}/${charValidation.limit} characters). ` +
      `Please shorten your message to fit on one page.`
    );
  }
}

// ============================================================================
// Draft Creation and Output Building
// ============================================================================

export interface CreateLetterDraftParams {
  sender: Address;
  recipient: Address;
  bodyText: string;
  signOff: string;
  layoutType: LetterLayoutType;
  headerImageData?: string;
  headerImageUrl?: string;
  inlineImageData?: string;
  inlineImageUrl?: string;
  senderValidation?: AddressValidationResult;
  recipientValidation?: AddressValidationResult;
  usedSavedReturnAddress: boolean;
  savedReturnAddressNote?: string;
  context: ToolContext;
}

export async function createLetterDraftAndBuildOutput(
  params: CreateLetterDraftParams
): Promise<LetterQuoteOutput> {
  const {
    sender,
    recipient,
    bodyText,
    signOff,
    layoutType,
    headerImageData,
    headerImageUrl,
    inlineImageData,
    inlineImageUrl,
    senderValidation,
    recipientValidation,
    usedSavedReturnAddress,
    savedReturnAddressNote,
    context
  } = params;

  // Calculate credits
  const requiredCredits = estimateRequiredCredits(bodyText, signOff);
  const available = context.user.creditsRemaining;
  const canSendNow = available >= requiredCredits;
  const lettersRequired = Math.max(1, Math.ceil(requiredCredits / 2));

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.computed",
      availableCredits: available,
      requiredCredits,
      lettersRequired,
      canSendNow
    },
    "Computed preview requirements"
  );

  // Generate preview HTML
  const previewHtml = renderLayoutPreviewHtml({
    sender,
    recipient,
    bodyText,
    signOff,
    layoutType,
    headerImageData,
    inlineImageData,
  });

  // Create draft
  const draftResult = await createDraft({
    userId: context.user.userId,
    sender: sender as unknown as Record<string, unknown>,
    recipient: recipient as unknown as Record<string, unknown>,
    bodyText,
    signOff,
    requiredCredits,
    previewHtml,
    senderValidation: senderValidation ? { status: senderValidation.status } : undefined,
    recipientValidation: recipientValidation ? { status: recipientValidation.status } : undefined,
    layoutType,
    headerImageData,
    headerImageUrl,
    inlineImageData,
    inlineImageUrl,
  });

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "quote.letter.draft_created",
      draftId: draftResult.draftId,
      layoutType,
      expiresAt: draftResult.expiresAt.toISOString()
    },
    "Draft created for idempotent send"
  );

  // Build output
  const output: LetterQuoteOutput = {
    previewHtml,
    lettersRequired,
    canSendNow,
    reasonCannotSend: canSendNow ? undefined : "Not enough letters in your balance.",
    deliveryClass: "First Class Letter",
    estimatedDeliveryDays: 5,
    draftId: draftResult.draftId,
    draftExpiresAt: draftResult.expiresAt.toISOString(),
    layoutType,
    headerImageData,
    inlineImageData,
    usedSavedReturnAddress: usedSavedReturnAddress || undefined,
    savedReturnAddressNote,
  };

  // Add address validation results
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
      originalAddress: recipient,
      verifiedAddress: recipientValidation.verifiedAddress ? {
        name: recipient.name,
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

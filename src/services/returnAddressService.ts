/**
 * Return Address Service
 *
 * Manages user's preferred return address for letters.
 * Validates addresses before saving using the letter provider.
 */

import { query } from '../db/index.js';
import { getLetterProvider } from './providers/index.js';
import type { AddressValidationInput, AddressValidationResult } from './providers/types.js';

/**
 * Address structure stored in database (matches frontend Address type)
 */
export interface ReturnAddress {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * Result from setting return address
 */
export interface SetReturnAddressResult {
  success: boolean;
  address?: ReturnAddress;
  validationStatus: 'verified' | 'corrected' | 'failed';
  wasAutoCorrected: boolean;
  originalAddress?: ReturnAddress;
  correctionDetails?: string;
  errors?: string[];
}

/**
 * Get user's saved return address
 *
 * @param userId - Auth0 user ID
 * @returns The saved return address or null if not set
 */
export async function getReturnAddress(userId: string): Promise<ReturnAddress | null> {
  const result = await query<{ return_address: ReturnAddress | null }>(
    `SELECT return_address FROM users WHERE user_id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].return_address;
}

/**
 * Set user's return address after validation
 *
 * The address will be validated using PostGrid. Only verified or corrected
 * addresses will be saved. For corrected addresses, the corrected version
 * is saved and the caller is informed of the changes.
 *
 * @param userId - Auth0 user ID
 * @param address - Address to validate and save
 * @returns Result with validation status and saved address
 */
export async function setReturnAddress(
  userId: string,
  address: ReturnAddress
): Promise<SetReturnAddressResult> {
  // Normalize country code
  const normalizedCountry = normalizeCountryToUS(address.country);

  // Validate US-only
  if (normalizedCountry !== 'US') {
    return {
      success: false,
      validationStatus: 'failed',
      wasAutoCorrected: false,
      errors: [`Letter IRL currently only supports US addresses. Provided country: ${address.country}`]
    };
  }

  const normalizedAddress: ReturnAddress = {
    ...address,
    country: normalizedCountry
  };

  // Get provider and validate address
  const provider = getLetterProvider();

  if (!provider.validateAddress) {
    // Provider doesn't support validation, save as-is
    console.log(`📫 Provider doesn't support address validation, saving address as-is`);
    await saveReturnAddress(userId, normalizedAddress);
    return {
      success: true,
      address: normalizedAddress,
      validationStatus: 'verified',
      wasAutoCorrected: false
    };
  }

  // Validate the address
  const validationInput: AddressValidationInput = {
    line1: address.addressLine1,
    line2: address.addressLine2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: normalizedCountry
  };

  let validation: AddressValidationResult;
  try {
    validation = await provider.validateAddress(validationInput);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown validation error';
    console.error(`❌ Address validation failed:`, errorMessage);
    return {
      success: false,
      validationStatus: 'failed',
      wasAutoCorrected: false,
      errors: [errorMessage]
    };
  }

  // Handle validation result
  if (validation.status === 'failed') {
    const errorMessages = validation.errors?.map(e => e.message) || ['Address is invalid or undeliverable'];
    console.log(`❌ Return address validation failed: ${errorMessages.join(', ')}`);
    return {
      success: false,
      validationStatus: 'failed',
      wasAutoCorrected: false,
      originalAddress: normalizedAddress,
      errors: errorMessages
    };
  }

  // Build the address to save (use corrected if available)
  let addressToSave: ReturnAddress;
  let wasAutoCorrected = false;
  let correctionDetails: string | undefined;

  if (validation.status === 'corrected' && validation.verifiedAddress) {
    // Use the corrected address
    addressToSave = {
      name: address.name, // Keep the user's name
      addressLine1: validation.verifiedAddress.line1,
      addressLine2: validation.verifiedAddress.line2,
      city: validation.verifiedAddress.city,
      state: validation.verifiedAddress.state,
      postalCode: validation.verifiedAddress.postalCode,
      country: validation.verifiedAddress.country
    };
    wasAutoCorrected = true;

    // Build correction details for the user
    const changes: string[] = [];
    if (address.addressLine1 !== addressToSave.addressLine1) {
      changes.push(`Street: "${address.addressLine1}" → "${addressToSave.addressLine1}"`);
    }
    if (address.city !== addressToSave.city) {
      changes.push(`City: "${address.city}" → "${addressToSave.city}"`);
    }
    if (address.state !== addressToSave.state) {
      changes.push(`State: "${address.state}" → "${addressToSave.state}"`);
    }
    if (address.postalCode !== addressToSave.postalCode) {
      changes.push(`ZIP: "${address.postalCode}" → "${addressToSave.postalCode}"`);
    }
    correctionDetails = changes.length > 0
      ? changes.join('; ')
      : 'Minor formatting corrections applied';

    console.log(`📫 Return address auto-corrected: ${correctionDetails}`);
  } else {
    // Address is verified as-is
    addressToSave = normalizedAddress;
  }

  // Save the validated address
  await saveReturnAddress(userId, addressToSave);

  console.log(`✅ Return address saved for user ${userId.substring(0, 15)}...`);

  return {
    success: true,
    address: addressToSave,
    validationStatus: validation.status,
    wasAutoCorrected,
    originalAddress: wasAutoCorrected ? normalizedAddress : undefined,
    correctionDetails
  };
}

/**
 * Clear user's saved return address
 *
 * @param userId - Auth0 user ID
 */
export async function clearReturnAddress(userId: string): Promise<void> {
  await query(
    `UPDATE users
     SET return_address = NULL,
         return_address_validated_at = NULL,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId]
  );

  console.log(`🗑️ Return address cleared for user ${userId.substring(0, 15)}...`);
}

/**
 * Check if user has a saved return address
 *
 * @param userId - Auth0 user ID
 * @returns true if user has a saved return address
 */
export async function hasReturnAddress(userId: string): Promise<boolean> {
  const address = await getReturnAddress(userId);
  return address !== null;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Save return address to database
 */
async function saveReturnAddress(userId: string, address: ReturnAddress): Promise<void> {
  await query(
    `UPDATE users
     SET return_address = $1,
         return_address_validated_at = NOW(),
         updated_at = NOW()
     WHERE user_id = $2`,
    [JSON.stringify(address), userId]
  );
}

/**
 * Normalize country code to US
 */
function normalizeCountryToUS(country?: string): string {
  if (!country) return 'US';
  const normalized = country.toUpperCase().trim();
  if (normalized === 'US' || normalized === 'USA' || normalized === 'UNITED STATES' ||
      normalized === 'U.S.' || normalized === 'U.S.A.') {
    return 'US';
  }
  return normalized;
}

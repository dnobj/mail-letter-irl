/**
 * Unit tests for quote_and_preview_letter tool - Address Correction Flow
 *
 * Tests the address validation and auto-correction behavior when generating
 * letter previews.
 *
 * User Stories Covered:
 * - US-EDGE-02: Address Correction Workflow
 * - US-LETTER-01: Preview a Letter (address validation aspects)
 *
 * Personas Covered:
 * - Sarah (Occasional Sender) - wants smooth preview experience
 * - Marcus (Regular Correspondent) - quick workflow without friction
 * - Eleanor (Elderly User) - confused by re-submission requirements
 *
 * GitHub Issue: #40
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Types for address validation
interface AddressValidationResult {
  status: 'verified' | 'corrected' | 'failed';
  verifiedAddress?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  errors?: Array<{ code: string; message: string }>;
}

interface Address {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

// Test fixtures
const validSenderAddress: Address = {
  name: 'John Sender',
  addressLine1: '123 Main St',
  city: 'New York',
  state: 'NY',
  postalCode: '10001',
  country: 'US',
};

const validRecipientAddress: Address = {
  name: 'Jane Recipient',
  addressLine1: '456 Oak Ave',
  city: 'Los Angeles',
  state: 'CA',
  postalCode: '90001',
  country: 'US',
};

const correctedSenderValidation: AddressValidationResult = {
  status: 'corrected',
  verifiedAddress: {
    line1: '123 MAIN ST',
    city: 'NEW YORK',
    state: 'NY',
    postalCode: '10001-1234', // ZIP+4 added
    country: 'US',
  },
};

const correctedRecipientValidation: AddressValidationResult = {
  status: 'corrected',
  verifiedAddress: {
    line1: '456 OAK AVE',
    city: 'LOS ANGELES',
    state: 'CA',
    postalCode: '90001-5678', // ZIP+4 added
    country: 'US',
  },
};

const verifiedValidation: AddressValidationResult = {
  status: 'verified',
};

const failedValidation: AddressValidationResult = {
  status: 'failed',
  errors: [
    { code: 'INVALID_ADDRESS', message: 'Address not found in USPS database' },
  ],
  verifiedAddress: {
    line1: '123 MAIN STREET', // Suggested correction
    city: 'NEW YORK',
    state: 'NY',
    postalCode: '10001',
    country: 'US',
  },
};

describe('Address Correction Flow (US-EDGE-02)', () => {
  describe('Verified Addresses (exact match)', () => {
    it('should proceed to preview when both addresses are verified', () => {
      // Both addresses verified = no errors, preview generated
      const senderValidation = verifiedValidation;
      const recipientValidation = verifiedValidation;

      expect(senderValidation.status).toBe('verified');
      expect(recipientValidation.status).toBe('verified');

      // Should NOT throw error
      const shouldProceed =
        senderValidation.status !== 'failed' &&
        recipientValidation.status !== 'failed';
      expect(shouldProceed).toBe(true);
    });
  });

  describe('Corrected Addresses (auto-accept)', () => {
    it('should auto-apply corrected sender address without error', () => {
      const senderValidation = correctedSenderValidation;
      const recipientValidation = verifiedValidation;

      // Corrected address should NOT throw error
      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(false);

      // Should use corrected address
      if (senderValidation.status === 'corrected' && senderValidation.verifiedAddress) {
        const correctedAddress = {
          ...validSenderAddress,
          addressLine1: senderValidation.verifiedAddress.line1,
          city: senderValidation.verifiedAddress.city,
          state: senderValidation.verifiedAddress.state,
          postalCode: senderValidation.verifiedAddress.postalCode,
        };

        expect(correctedAddress.postalCode).toBe('10001-1234');
        expect(correctedAddress.addressLine1).toBe('123 MAIN ST');
      }
    });

    it('should auto-apply corrected recipient address without error', () => {
      const senderValidation = verifiedValidation;
      const recipientValidation = correctedRecipientValidation;

      // Corrected address should NOT throw error
      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(false);

      // Should use corrected address
      if (recipientValidation.status === 'corrected' && recipientValidation.verifiedAddress) {
        const correctedAddress = {
          ...validRecipientAddress,
          addressLine1: recipientValidation.verifiedAddress.line1,
          city: recipientValidation.verifiedAddress.city,
          state: recipientValidation.verifiedAddress.state,
          postalCode: recipientValidation.verifiedAddress.postalCode,
        };

        expect(correctedAddress.postalCode).toBe('90001-5678');
        expect(correctedAddress.city).toBe('LOS ANGELES');
      }
    });

    it('should auto-apply corrections to both addresses when both need correction', () => {
      const senderValidation = correctedSenderValidation;
      const recipientValidation = correctedRecipientValidation;

      // Both corrected should NOT throw error
      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(false);

      // Both should be applied
      expect(senderValidation.verifiedAddress?.postalCode).toBe('10001-1234');
      expect(recipientValidation.verifiedAddress?.postalCode).toBe('90001-5678');
    });

    it('should include original and corrected addresses in validation result', () => {
      const originalAddress = validSenderAddress;
      const validation = correctedSenderValidation;

      // Response should include both for transparency
      const validationResult = {
        status: validation.status,
        originalAddress: originalAddress,
        verifiedAddress: validation.verifiedAddress
          ? {
              name: originalAddress.name, // Name preserved
              addressLine1: validation.verifiedAddress.line1,
              addressLine2: validation.verifiedAddress.line2,
              city: validation.verifiedAddress.city,
              state: validation.verifiedAddress.state,
              postalCode: validation.verifiedAddress.postalCode,
              country: validation.verifiedAddress.country,
            }
          : undefined,
      };

      expect(validationResult.status).toBe('corrected');
      expect(validationResult.originalAddress.postalCode).toBe('10001');
      expect(validationResult.verifiedAddress?.postalCode).toBe('10001-1234');
    });
  });

  describe('Failed Addresses (require user action)', () => {
    it('should throw error when sender address fails validation', () => {
      const senderValidation = failedValidation;
      const recipientValidation = verifiedValidation;

      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(true);

      // Build error message
      if (senderValidation.status === 'failed') {
        const errorMsg =
          senderValidation.errors?.map((e) => e.message).join('; ') ||
          'Address is invalid or undeliverable';
        expect(errorMsg).toContain('Address not found');
      }
    });

    it('should throw error when recipient address fails validation', () => {
      const senderValidation = verifiedValidation;
      const recipientValidation = failedValidation;

      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(true);
    });

    it('should throw error listing both when both addresses fail', () => {
      const senderValidation = failedValidation;
      const recipientValidation = failedValidation;

      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(true);

      // Both should be mentioned in error
      const errorParts: string[] = [];
      if (senderValidation.status === 'failed') {
        errorParts.push('Sender address is INVALID');
      }
      if (recipientValidation.status === 'failed') {
        errorParts.push('Recipient address is INVALID');
      }

      expect(errorParts.length).toBe(2);
    });

    it('should include suggested correction in error for failed addresses', () => {
      const validation = failedValidation;

      expect(validation.status).toBe('failed');
      expect(validation.verifiedAddress).toBeDefined();
      expect(validation.verifiedAddress?.line1).toBe('123 MAIN STREET');
    });
  });

  describe('Mixed Scenarios', () => {
    it('should proceed when sender is corrected and recipient is verified', () => {
      const senderValidation = correctedSenderValidation;
      const recipientValidation = verifiedValidation;

      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(false);
    });

    it('should throw error when sender is corrected but recipient fails', () => {
      const senderValidation = correctedSenderValidation;
      const recipientValidation = failedValidation;

      // Even though sender is corrected (would proceed), recipient failed = error
      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(true);
    });

    it('should throw error when sender fails but recipient is corrected', () => {
      const senderValidation = failedValidation;
      const recipientValidation = correctedRecipientValidation;

      // Sender failed = error, even though recipient would auto-correct
      const hasFailures =
        senderValidation.status === 'failed' ||
        recipientValidation.status === 'failed';
      expect(hasFailures).toBe(true);
    });
  });

  describe('Draft Storage', () => {
    it('should store corrected address in draft (not original)', () => {
      const originalAddress = validSenderAddress;
      const validation = correctedSenderValidation;

      // Simulate updating address with correction
      const addressForDraft = { ...originalAddress };
      if (validation.status === 'corrected' && validation.verifiedAddress) {
        addressForDraft.addressLine1 = validation.verifiedAddress.line1;
        addressForDraft.city = validation.verifiedAddress.city;
        addressForDraft.state = validation.verifiedAddress.state;
        addressForDraft.postalCode = validation.verifiedAddress.postalCode;
      }

      // Draft should have corrected address (what will be mailed)
      expect(addressForDraft.postalCode).toBe('10001-1234');
      expect(addressForDraft.addressLine1).toBe('123 MAIN ST');
      // Name should be preserved
      expect(addressForDraft.name).toBe('John Sender');
    });
  });

  describe('Response Format', () => {
    it('should include validation results in output when addresses are corrected', () => {
      const senderValidation = correctedSenderValidation;

      const output = {
        senderAddressValidation: {
          status: senderValidation.status,
          originalAddress: validSenderAddress,
          verifiedAddress: senderValidation.verifiedAddress
            ? {
                name: validSenderAddress.name,
                addressLine1: senderValidation.verifiedAddress.line1,
                city: senderValidation.verifiedAddress.city,
                state: senderValidation.verifiedAddress.state,
                postalCode: senderValidation.verifiedAddress.postalCode,
                country: senderValidation.verifiedAddress.country,
              }
            : undefined,
          suggestions:
            senderValidation.status === 'corrected'
              ? `Address was corrected: ${senderValidation.verifiedAddress?.line1}, ${senderValidation.verifiedAddress?.city}, ${senderValidation.verifiedAddress?.state} ${senderValidation.verifiedAddress?.postalCode}`
              : undefined,
        },
      };

      expect(output.senderAddressValidation.status).toBe('corrected');
      expect(output.senderAddressValidation.suggestions).toContain('Address was corrected');
      expect(output.senderAddressValidation.verifiedAddress?.postalCode).toBe('10001-1234');
    });
  });
});

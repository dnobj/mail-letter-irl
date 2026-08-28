import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/services/providers/index.js", () => ({
  getLetterProvider: vi.fn()
}));

import { getLetterProvider } from "../../../src/services/providers/index.js";
import { validateAddressesWithProvider } from "../../../src/tools/letterHelpers.js";
import type { AddressValidationResult } from "../../../src/services/providers/types.js";
import type { Address, ToolContext } from "../../../src/contracts/types.js";

// Real-path coverage for the decision layer all four preview tools share
// (the postcard tool calls this same function since issue #200). Earlier
// "coverage" re-implemented this logic inside the test file and never
// touched src/ - these tests drive the actual function.

const context = {
  user: { userId: "user-1", creditsRemaining: 5 },
  correlationId: "test",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
} as unknown as ToolContext;

function address(overrides: Partial<Address> = {}): Address {
  return {
    name: "Pat Example",
    addressLine1: "350 5th Ave",
    addressLine2: "Suite 8701",
    city: "New York",
    state: "NY",
    postalCode: "10118",
    country: "US",
    ...overrides
  };
}

const verifiedResult: AddressValidationResult = {
  status: "verified",
  isValid: true,
  originalAddress: { line1: "123 Test St" }
};

const suiteFailedResult: AddressValidationResult = {
  status: "failed",
  isValid: false,
  originalAddress: { line1: "350 5th Ave", line2: "Suite 8701" },
  verifiedAddress: {
    line1: "350 5th Ave Ste 8701",
    city: "New York",
    state: "NY",
    postalCode: "10118",
    country: "US"
  },
  errors: [{ field: "line1", message: "Incorrect Value: Suite identifier" }],
  details: {
    streetName: "5TH",
    suiteID: "8701",
    suiteKey: "STE",
    usMailingsDpvConfirmationIndicator: "S"
  }
};

const hardFailedResult: AddressValidationResult = {
  status: "failed",
  isValid: false,
  originalAddress: { line1: "123 Fake Street" },
  errors: [{ field: "generic", message: "Missing Value: Complete Street Information" }],
  details: {}
};

const transportResult: AddressValidationResult = {
  status: "failed",
  isValid: false,
  transportError: true,
  originalAddress: { line1: "350 5th Ave" },
  errors: [{ field: "address", message: "HTTP 503" }]
};

function mockValidate(sender: AddressValidationResult, recipient: AddressValidationResult) {
  const validateAddress = vi
    .fn()
    .mockResolvedValueOnce(sender)
    .mockResolvedValueOnce(recipient);
  vi.mocked(getLetterProvider).mockReturnValue({ validateAddress } as never);
  return validateAddress;
}

describe("validateAddressesWithProvider (issue #200 policy)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("proceeds with a warning when only the recipient's unit is unconfirmed", async () => {
    mockValidate(verifiedResult, suiteFailedResult);

    const results = await validateAddressesWithProvider(
      address({ addressLine1: "123 Test St", addressLine2: undefined }),
      address(),
      context
    );

    expect(results.recipientValidation?.status).toBe("failed");
    expect(results.addressWarnings).toHaveLength(1);
    expect(results.addressWarnings?.[0]).toContain("STE 8701");
  });

  it("proceeds with a warning when verification itself is unavailable", async () => {
    mockValidate(transportResult, transportResult);

    const results = await validateAddressesWithProvider(address(), address(), context);

    expect(results.addressWarnings).toHaveLength(2);
    expect(results.addressWarnings?.[0]).toContain("could not be verified right now");
  });

  it("still blocks an unresolvable street, with actionable copy", async () => {
    mockValidate(verifiedResult, hardFailedResult);

    await expect(
      validateAddressesWithProvider(address(), address({ addressLine1: "123 Fake Street" }), context)
    ).rejects.toThrow(/could not be delivered to.*Check the street number/s);
  });

  it("auto-applies corrections exactly as before", async () => {
    const corrected: AddressValidationResult = {
      status: "corrected",
      isValid: true,
      originalAddress: { line1: "1600 amphitheatre parkway" },
      verifiedAddress: {
        line1: "1600 Amphitheatre Pkwy",
        city: "Mountain View",
        state: "CA",
        postalCode: "94043",
        country: "US"
      }
    };
    mockValidate(verifiedResult, corrected);
    const recipient = address({ addressLine1: "1600 amphitheatre parkway" });

    const results = await validateAddressesWithProvider(address(), recipient, context);

    expect(recipient.addressLine1).toBe("1600 Amphitheatre Pkwy");
    expect(results.addressWarnings).toBeUndefined();
  });

  it("skips validation entirely when the provider has no validateAddress", async () => {
    vi.mocked(getLetterProvider).mockReturnValue({} as never);

    const results = await validateAddressesWithProvider(address(), address(), context);

    expect(results.senderValidation).toBeUndefined();
    expect(results.addressWarnings).toBeUndefined();
  });
});

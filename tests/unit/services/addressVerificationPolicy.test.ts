import { describe, expect, it } from "vitest";
import {
  assessValidation,
  classifyFailedValidation
} from "../../../src/services/addressVerificationPolicy.js";
import type { AddressValidationResult } from "../../../src/services/providers/types.js";

// Fixtures modeled on the live PostGrid addver probe of 2026-08-22
// (docs/learnings/suite-address-verification.md). The DPV indicator arrives
// in details.usMailingsDpvConfirmationIndicator; suite errors are keyed
// under "line1", so field names cannot discriminate - the indicator does.

function suiteNotOnFile(overrides: Partial<AddressValidationResult> = {}): AddressValidationResult {
  return {
    status: "failed",
    isValid: false,
    originalAddress: {
      line1: "350 5th Ave",
      line2: "Suite 8701",
      city: "New York",
      state: "NY",
      postalCode: "10118",
      country: "US"
    },
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
      streetNumber: "350",
      suiteID: "8701",
      suiteKey: "STE",
      usMailingsDpvConfirmationIndicator: "S"
    },
    ...overrides
  };
}

function unitRequiredMissing(): AddressValidationResult {
  return suiteNotOnFile({
    originalAddress: {
      line1: "350 5th Ave",
      city: "New York",
      state: "NY",
      postalCode: "10118",
      country: "US"
    },
    errors: [{ field: "line1", message: "Missing Value: Suite identifier" }],
    details: {
      streetName: "5TH",
      streetNumber: "350",
      usMailingsDpvConfirmationIndicator: "D"
    }
  });
}

function garbageStreet(): AddressValidationResult {
  return {
    status: "failed",
    isValid: false,
    originalAddress: {
      line1: "123 Fake Street",
      city: "Nowhere",
      state: "CA",
      postalCode: "90210",
      country: "US"
    },
    // PostGrid echoes the input back even when nothing resolves.
    verifiedAddress: {
      line1: "123 Fake Street",
      city: "Nowhere",
      state: "CA",
      postalCode: "90210",
      country: "US"
    },
    errors: [{ field: "generic", message: "Missing Value: Complete Street Information" }],
    details: {}
  };
}

function transportFailure(): AddressValidationResult {
  return {
    status: "failed",
    isValid: false,
    transportError: true,
    originalAddress: { line1: "350 5th Ave", city: "New York" },
    errors: [{ field: "address", message: "HTTP 401: Invalid API key" }]
  };
}

describe("classifyFailedValidation", () => {
  it("classifies DPV S (unit given, not on file) as secondary_unit", () => {
    expect(classifyFailedValidation(suiteNotOnFile())).toBe("secondary_unit");
  });

  it("classifies DPV D (unit required, missing) as secondary_unit", () => {
    expect(classifyFailedValidation(unitRequiredMissing())).toBe("secondary_unit");
  });

  it("falls back to the message text when DPV details are absent", () => {
    const noDetails = suiteNotOnFile({ details: undefined });
    expect(classifyFailedValidation(noDetails)).toBe("secondary_unit");
  });

  it("classifies an unresolvable street as address_failed", () => {
    expect(classifyFailedValidation(garbageStreet())).toBe("address_failed");
  });

  it("classifies a transport failure as service_error", () => {
    expect(classifyFailedValidation(transportFailure())).toBe("service_error");
  });
});

describe("assessValidation", () => {
  it("passes verified and corrected through", () => {
    expect(
      assessValidation("Recipient", { ...suiteNotOnFile(), status: "verified", isValid: true })
        .outcome
    ).toBe("verified");
    expect(
      assessValidation("Recipient", { ...suiteNotOnFile(), status: "corrected", isValid: true })
        .outcome
    ).toBe("corrected");
  });

  it("proceeds with a unit-specific warning when the unit is not on file", () => {
    const assessment = assessValidation("Recipient", suiteNotOnFile());
    expect(assessment.outcome).toBe("unverified");
    expect(assessment.warning).toContain('"STE 8701"');
    expect(assessment.warning).toContain("building is deliverable");
  });

  it("proceeds with an add-the-unit warning when a required unit is missing", () => {
    const assessment = assessValidation("Recipient", unitRequiredMissing());
    expect(assessment.outcome).toBe("unverified");
    expect(assessment.warning).toContain("requires an apartment or suite number");
  });

  it("proceeds with a service warning on transport failure", () => {
    const assessment = assessValidation("Sender", transportFailure());
    expect(assessment.outcome).toBe("unverified");
    expect(assessment.warning).toContain("could not be verified right now");
  });

  it("blocks an unresolvable street with actionable copy and no echoed suggestion", () => {
    const assessment = assessValidation("Recipient", garbageStreet());
    expect(assessment.outcome).toBe("blocked");
    expect(assessment.blockText).toContain("could not be delivered to");
    expect(assessment.blockText).toContain("Check the street number");
    // The echoed input must not be presented as a "closest match".
    expect(assessment.blockText).not.toContain("Closest match");
  });

  it("offers the standardized match when the street resolved but the address still failed", () => {
    const resolvedButFailed = suiteNotOnFile({
      details: { streetName: "5TH", streetNumber: "350" },
      errors: [{ field: "generic", message: "Some other hard failure" }]
    });
    const assessment = assessValidation("Recipient", resolvedButFailed);
    expect(assessment.outcome).toBe("blocked");
    expect(assessment.blockText).toContain("Closest match on record");
    expect(assessment.blockText).toContain("350 5th Ave Ste 8701");
  });
});

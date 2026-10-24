import { describe, expect, it } from "vitest";
import {
  assessValidation,
  classifyFailedValidation,
  isUsCorrection
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

// Observed on DEV 2026-10-23: a verifier answering from a PostGrid test key
// "corrected" a New York recipient to Toronto, and the postcard was mailed
// there. Letter IRL mails only within the U.S.
function correctedTo(verifiedAddress: Partial<NonNullable<AddressValidationResult["verifiedAddress"]>>): AddressValidationResult {
  return {
    status: "corrected",
    isValid: true,
    originalAddress: {
      line1: "20 W 34th St",
      city: "New York",
      state: "NY",
      postalCode: "10001",
      country: "US"
    },
    verifiedAddress: {
      line1: "20 W 34th St",
      city: "New York",
      state: "NY",
      postalCode: "10001-3005",
      country: "us",
      ...verifiedAddress
    }
  };
}

describe("corrections outside the U.S.", () => {
  it("refuses the observed Toronto correction of a New York address", () => {
    const assessment = assessValidation(
      "Recipient",
      correctedTo({ line1: "20 W 34th St", city: "TORONTO", state: "ON", postalCode: "M5J2N8", country: "CA" })
    );
    expect(assessment.outcome).toBe("blocked");
    expect(assessment.correction).toBeUndefined();
    expect(assessment.blockText).toContain("Recipient address could not be confirmed");
    expect(assessment.blockText).toContain("outside the U.S.");
    expect(assessment.blockText).toContain("Check the street number, street name, city, state, and ZIP.");
    // The made-up match is not offered back as a suggestion.
    expect(assessment.blockText).not.toContain("TORONTO");
  });

  it.each([
    ["a non-US country", { country: "CA" }],
    ["a province code under a US country", { state: "ON" }],
    ["a full state name", { state: "New York" }],
    ["a Canadian postal code", { postalCode: "M5J 2N8" }],
    ["a missing ZIP", { postalCode: "" }],
    ["a missing country", { country: "" }]
  ])("refuses a correction with %s", (_case, change) => {
    const assessment = assessValidation("Sender", correctedTo(change));
    expect(assessment.outcome).toBe("blocked");
    expect(assessment.correction).toBeUndefined();
  });

  it.each([
    ["PostGrid's lower-case us", { country: "us" }],
    ["USA", { country: "USA" }],
    ["a lower-case state", { state: "ny" }],
    ["a five-digit ZIP", { postalCode: "10001" }],
    ["a ZIP+4 without the hyphen", { postalCode: "100013005" }],
    ["a territory", { state: "PR", city: "San Juan", postalCode: "00901" }],
    ["a military post office", { state: "AE", city: "APO", postalCode: "09012" }]
  ])("hands over a US correction with %s", (_case, change) => {
    const validation = correctedTo(change);
    const assessment = assessValidation("Recipient", validation);
    expect(assessment.outcome).toBe("corrected");
    expect(assessment.correction).toEqual(validation.verifiedAddress);
    expect(isUsCorrection(validation.verifiedAddress!)).toBe(true);
  });

  it("hands over nothing to apply when a correction carries no address", () => {
    const assessment = assessValidation("Recipient", { ...correctedTo({}), verifiedAddress: undefined });
    expect(assessment).toEqual({ outcome: "corrected" });
  });

  it("never hands over a correction for a verified or failed result", () => {
    expect(assessValidation("Recipient", { ...correctedTo({}), status: "verified" }).correction).toBeUndefined();
    expect(assessValidation("Recipient", suiteNotOnFile()).correction).toBeUndefined();
  });
});

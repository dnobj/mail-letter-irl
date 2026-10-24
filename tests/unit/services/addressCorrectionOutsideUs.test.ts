import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db/index.js", () => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("../../../src/services/providers/index.js", () => ({
  getLetterProvider: vi.fn()
}));

import { query } from "../../../src/db/index.js";
import { getLetterProvider } from "../../../src/services/providers/index.js";
import { PostGridProvider } from "../../../src/services/providers/PostGridProvider.js";
import {
  assessValidation,
  OUTSIDE_US_CORRECTION_REASON
} from "../../../src/services/addressVerificationPolicy.js";
import { setReturnAddress } from "../../../src/services/returnAddressService.js";

// Observed on DEV 2026-10-23: with a PostGrid test key behind address
// verification, a postcard to 20 W 34th St, New York, NY 10001 was
// "corrected" to Toronto and mailed there. Letter IRL mails only within the
// U.S., so a correction outside it is refused wherever corrections apply.

const NEW_YORK = {
  line1: "20 W 34th St",
  city: "New York",
  state: "NY",
  postalCode: "10001",
  country: "US"
};

const TORONTO_BODY = {
  status: "success",
  message: "Address verification processed.",
  data: {
    city: "TORONTO",
    country: "ca",
    line1: "20 W 34th St",
    postalOrZip: "M5J2N8",
    provinceOrState: "ON",
    status: "corrected"
  }
};

describe("PostGrid's correction outside the U.S.", () => {
  beforeEach(() => {
    process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY;
  });

  it("reaches the policy as a correction, which refuses it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(TORONTO_BODY), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    const provider = new PostGridProvider(
      { name: "postgrid", displayName: "PostGrid", enabled: true },
      { apiKey: "test-key", timeoutMs: 100 }
    );

    const result = await provider.validateAddress(NEW_YORK);

    expect(result.status).toBe("corrected");
    expect(result.verifiedAddress).toMatchObject({ city: "TORONTO", state: "ON", postalCode: "M5J2N8", country: "ca" });
    const assessment = assessValidation("Recipient", result);
    expect(assessment.outcome).toBe("blocked");
    expect(assessment.correction).toBeUndefined();
  });
});

describe("setReturnAddress with a correction outside the U.S.", () => {
  afterEach(() => vi.restoreAllMocks());

  function correctedTo(verifiedAddress: Record<string, string>) {
    vi.mocked(getLetterProvider).mockReturnValue({
      validateAddress: vi.fn().mockResolvedValue({
        status: "corrected",
        isValid: true,
        originalAddress: NEW_YORK,
        verifiedAddress
      })
    } as never);
  }

  const given = {
    name: "Pat Example",
    addressLine1: "20 W 34th St",
    city: "New York",
    state: "NY",
    postalCode: "10001",
    country: "US"
  };

  it("refuses it and saves nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(query).mockReset().mockResolvedValue({ rows: [], rowCount: 1 } as never);
    correctedTo({ line1: "20 W 34th St", city: "TORONTO", state: "ON", postalCode: "M5J2N8", country: "CA" });

    const result = await setReturnAddress("auth0|user", given);

    expect(result).toMatchObject({
      success: false,
      validationStatus: "failed",
      wasAutoCorrected: false,
      errors: [OUTSIDE_US_CORRECTION_REASON]
    });
    expect(result.address).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("still saves a US correction", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(query).mockReset().mockResolvedValue({ rows: [], rowCount: 1 } as never);
    correctedTo({ line1: "20 W 34TH ST", city: "NEW YORK", state: "NY", postalCode: "10001-3005", country: "us" });

    const result = await setReturnAddress("auth0|user", given);

    expect(result).toMatchObject({ success: true, wasAutoCorrected: true, validationStatus: "corrected" });
    expect(result.address).toMatchObject({ addressLine1: "20 W 34TH ST", postalCode: "10001-3005" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

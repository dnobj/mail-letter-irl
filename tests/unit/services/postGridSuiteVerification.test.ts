import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostGridProvider } from "../../../src/services/providers/PostGridProvider.js";

// Response bodies modeled on the live addver probe of 2026-08-22
// (docs/learnings/suite-address-verification.md).

function makeProvider(): PostGridProvider {
  return new PostGridProvider(
    { name: "postgrid", displayName: "PostGrid", enabled: true },
    { apiKey: "test-key", timeoutMs: 100 }
  );
}

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
      })
    )
  );
}

const SUITE_FAILED_BODY = {
  status: "success",
  message: "Address verification processed.",
  data: {
    city: "New York",
    country: "us",
    details: {
      streetName: "5TH",
      streetType: "AVE",
      streetNumber: "350",
      suiteID: "8701",
      suiteKey: "STE",
      usMailingsDpvConfirmationIndicator: "S"
    },
    errors: {
      line1: ["Incorrect Value: Suite identifier"]
    },
    line1: "350 5th Ave Ste 8701",
    postalOrZip: "10118",
    provinceOrState: "NY",
    status: "failed",
    zipPlus4: "0110"
  }
};

describe("PostGridProvider.validateAddress - suite handling (issue #200)", () => {
  beforeEach(() => {
    process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.POSTGRID_ADDRESS_VERIFICATION_API_KEY;
  });

  it("keeps the standardized address and DPV details on a failed response", async () => {
    stubFetch(SUITE_FAILED_BODY);
    const provider = makeProvider();

    const result = await provider.validateAddress({
      line1: "350 5th Ave",
      line2: "Suite 8701",
      city: "New York",
      state: "NY",
      postalCode: "10118",
      country: "US"
    });

    expect(result.status).toBe("failed");
    expect(result.isValid).toBe(false);
    // Previously discarded on failed - the policy layer needs both of these.
    expect(result.verifiedAddress?.line1).toBe("350 5th Ave Ste 8701");
    expect(result.details?.usMailingsDpvConfirmationIndicator).toBe("S");
    // Error field keys survive the flattening.
    expect(result.errors).toEqual([
      { field: "line1", message: "Incorrect Value: Suite identifier" }
    ]);
    expect(result.transportError).toBeUndefined();
  });

  it("marks transport failures so they cannot masquerade as invalid addresses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ETIMEDOUT")));
    const provider = makeProvider();

    const result = await provider.validateAddress({
      line1: "350 5th Ave",
      city: "New York",
      state: "NY",
      postalCode: "10118",
      country: "US"
    });

    expect(result.status).toBe("failed");
    expect(result.transportError).toBe(true);
  });
});

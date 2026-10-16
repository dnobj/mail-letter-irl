import { describe, expect, it } from "vitest";

import { resolveCorsOriginFor } from "../../../src/mcp/corsOrigin.js";

const ALLOWED = ["https://letterirl.com", "https://www.letterirl.com"];
const FALLBACK = "https://letterirl.com";

describe("resolveCorsOriginFor", () => {
  it("reflects an allowlisted origin and nothing else", () => {
    expect(resolveCorsOriginFor("https://www.letterirl.com", ALLOWED, FALLBACK)).toBe("https://www.letterirl.com");
    expect(resolveCorsOriginFor("https://evil.example", ALLOWED, FALLBACK)).toBe(FALLBACK);
    expect(resolveCorsOriginFor(undefined, ALLOWED, FALLBACK)).toBe(FALLBACK);
    expect(resolveCorsOriginFor("", ALLOWED, FALLBACK)).toBe(FALLBACK);
  });

  it("never answers a null origin with a wildcard", () => {
    // A file:// page or a sandboxed frame sends the literal string "null".
    // It used to get "*" (audit A-11); it gets the fallback like any other
    // origin that is not on the list.
    const answer = resolveCorsOriginFor("null", ALLOWED, FALLBACK);
    expect(answer).toBe(FALLBACK);
    expect(answer).not.toBe("*");
  });

  it("uses the first value when several Origin headers arrive", () => {
    expect(resolveCorsOriginFor(["https://letterirl.com", "https://evil.example"], ALLOWED, FALLBACK)).toBe(
      "https://letterirl.com",
    );
    expect(resolveCorsOriginFor(["null", "https://letterirl.com"], ALLOWED, FALLBACK)).toBe(FALLBACK);
  });
});

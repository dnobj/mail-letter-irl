/**
 * The parts of get_profile (#424) that live outside the tool file: what the
 * model is told, and what the runtime output schema admits. Both were found by
 * mutation - the handler tests could not see either.
 */

import { describe, it, expect } from "vitest";
import { summarizeToolResult } from "../../../src/mcp/registerTools.js";
import { getProfileOutputZ } from "../../../src/zodSchemas.js";

describe("get_profile: what the model is told", () => {
  it("narrates the address and never the id", () => {
    // The id is for ChatGPT, delivered in structuredContent. The model has no
    // use for it, and an opaque subject string in its context is noise at
    // best and something it might repeat to the customer at worst.
    const text = summarizeToolResult("get_profile", {
      id: "google-oauth2|100183416573162262799",
      email: "person@example.com"
    });
    expect(text).toBe("Account: person@example.com");
    expect(text).not.toContain("google-oauth2");
    expect(text).not.toContain("100183416573162262799");
  });

  it("says only that the account was identified when there is no address", () => {
    const text = summarizeToolResult("get_profile", { id: "auth0|abc" });
    expect(text).toBe("Account identified.");
    expect(text).not.toContain("auth0|abc");
  });
});

describe("get_profile: what the runtime output schema admits", () => {
  // The MCP SDK validates structuredContent against this before it leaves
  // the server, and ChatGPT validates the profile again on arrival: "Be a
  // non-empty, non-whitespace string". An empty id must fail here, not there.
  it("refuses an empty id", () => {
    expect(getProfileOutputZ.safeParse({ id: "" }).success).toBe(false);
  });

  it("accepts an id alone, and an id with an address", () => {
    expect(getProfileOutputZ.safeParse({ id: "auth0|abc" }).success).toBe(true);
    expect(getProfileOutputZ.safeParse({ id: "auth0|abc", email: "a@example.com" }).success).toBe(true);
  });
});

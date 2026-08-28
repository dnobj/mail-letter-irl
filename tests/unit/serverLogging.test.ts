import { describe, expect, it } from "vitest";
import { summarizeToolInput } from "../../src/server.js";

describe("tool input logging privacy", () => {
  it("records structure without primitive values or nested content", () => {
    const sensitiveInput = {
      message: "Private letter body",
      recipientName: "Jane Recipient",
      postalCode: "90210",
      saveReturnAddress: true,
      address: {
        line1: "123 Secret St"
      }
    };

    const summary = summarizeToolInput(sensitiveInput);
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual({
      fieldCount: 5,
      fields: [
        { name: "message", type: "string" },
        { name: "recipientName", type: "string" },
        { name: "postalCode", type: "string" },
        { name: "saveReturnAddress", type: "boolean" },
        { name: "address", type: "object" }
      ]
    });
    expect(serialized).not.toContain("Private letter body");
    expect(serialized).not.toContain("Jane Recipient");
    expect(serialized).not.toContain("90210");
    expect(serialized).not.toContain("123 Secret St");
  });
});

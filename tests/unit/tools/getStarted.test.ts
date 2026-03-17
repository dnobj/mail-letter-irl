import { describe, expect, it } from "vitest";
import { getStartedTool } from "../../../src/tools/getStarted.js";

describe("get_started tool", () => {
  it("should be read-only", () => {
    expect(getStartedTool.readOnly).toBe(true);
  });

  it("should render the onboarding widget", () => {
    expect(getStartedTool.meta["openai/outputTemplate"]).toBe(
      "ui://widgets/GetStartedCard.html"
    );
  });

  it("should return onboarding guidance", async () => {
    const result = await getStartedTool.handler({}, {} as never);

    expect(result.title).toContain("Get Started");
    expect(result.purchaseStep).toContain("letterirl.com");
    expect(result.examplePrompts.length).toBeGreaterThanOrEqual(3);
  });
});

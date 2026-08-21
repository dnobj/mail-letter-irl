import { describe, expect, it } from "vitest";
import { generateImageForMailTool } from "../../../src/tools/generateImageForMail.js";

/**
 * Intent trampoline for issue #227's native-app papercut: an @-mention
 * "generate an image" ask must land on a matching tool whose OUTPUT redirects
 * the model to built-in generation in the same turn, instead of producing a
 * capability narration. Decision record:
 * docs/learnings/generate-image-removal-decision.md (Addendum 2).
 */
describe("generate_image_for_mail (intent router)", () => {
  it("is read-only, widget-free, and honestly named a router", () => {
    expect(generateImageForMailTool.name).toBe("generate_image_for_mail");
    expect(generateImageForMailTool.readOnly).toBe(true);
    // No widget: the whole point is a sub-second invisible hop.
    expect(generateImageForMailTool.meta["openai/outputTemplate"]).toBeUndefined();
    // The description must invite the call for generate-intent AND state that
    // nothing is generated server-side (submission-review honesty).
    expect(generateImageForMailTool.description).toContain(
      "does not generate images itself"
    );
    expect(generateImageForMailTool.description).toContain("built-in image generation");
  });

  it("redirects to image_gen in the same turn, without narrating the routing", async () => {
    const result = await generateImageForMailTool.handler({}, {} as never);
    expect(result.status).toBe("use_builtin_generation");
    expect(result.suggestedNextStep).toContain("in this same turn");
    expect(result.suggestedNextStep).toContain("image_gen");
    expect(result.suggestedNextStep).toContain("Do not explain this routing");
  });

  it("carries the user's prompt into the redirect", async () => {
    const result = await generateImageForMailTool.handler(
      { prompt: "a bear painting a fence" },
      {} as never
    );
    expect(result.suggestedNextStep).toContain('"a bear painting a fence"');
  });

  it.each([
    ["postcard", "postcard"],
    ["header_image", "letter"],
    ["inline_image", "letter"],
    [undefined, "postcard or letter"]
  ] as const)("maps context %s to the %s offer", async (context, noun) => {
    const result = await generateImageForMailTool.handler(
      { context: context as string | undefined },
      {} as never
    );
    expect(result.suggestedNextStep).toContain(`offer to use it for a ${noun}`);
  });
});

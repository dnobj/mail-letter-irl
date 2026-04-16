import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LetterIrlServer } from "../../../src/server.js";
import { buildManifest, stringifyManifest } from "../../../src/mcp/manifest.js";
import { WIDGET_DEFINITIONS } from "../../../src/mcp/registerTools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(__dirname, "../../../manifest.json");

describe("Compatibility manifest", () => {
  it("should mirror the runtime tool registry", () => {
    const runtimeTools = new LetterIrlServer().listTools().map((tool) => tool.name).sort();
    const manifestTools = buildManifest().tools.map((tool) => tool.name).sort();

    expect(manifestTools).toEqual(runtimeTools);
  });

  it("should mirror registered widget resources", () => {
    const manifestWidgets = buildManifest().ui.widgets;
    const runtimeWidgets = WIDGET_DEFINITIONS.map((widget) => widget.name);

    expect(manifestWidgets).toEqual(runtimeWidgets);
  });

  it("should keep the checked-in manifest.json snapshot in sync", () => {
    const snapshot = fs.readFileSync(manifestPath, "utf-8");
    expect(snapshot).toBe(stringifyManifest());
  });

  it("should advertise generate_image as a fallback when native image generation is unavailable", () => {
    const generateImageTool = buildManifest().tools.find((tool) => tool.name === "generate_image");

    expect(generateImageTool?.description).toContain("native ChatGPT image generation is unavailable");
    expect(generateImageTool?.description).toContain("Use this even if the user has not yet asked to mail it");
  });

  it("should keep generate_image inside the first 12 registered tools for ChatGPT exposure", () => {
    const firstTwelveToolNames = new LetterIrlServer()
      .listTools()
      .slice(0, 12)
      .map((tool) => tool.name);

    expect(firstTwelveToolNames).toContain("generate_image");
  });
});

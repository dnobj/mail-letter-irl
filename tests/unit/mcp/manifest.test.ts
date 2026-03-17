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
});

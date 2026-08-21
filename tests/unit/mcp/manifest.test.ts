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
    const previousPublicBaseUrl = process.env.LETTER_IRL_PUBLIC_BASE_URL;
    process.env.LETTER_IRL_PUBLIC_BASE_URL = "https://api.letterirl.com";

    try {
      expect(snapshot).toBe(stringifyManifest());
    } finally {
      if (previousPublicBaseUrl === undefined) {
        delete process.env.LETTER_IRL_PUBLIC_BASE_URL;
      } else {
        process.env.LETTER_IRL_PUBLIC_BASE_URL = previousPublicBaseUrl;
      }
    }
  });

  it("should allow runtime callers to advertise the request public base URL", () => {
    const manifest = buildManifest("https://api.letterirl.com");

    expect(manifest.servers[0].url).toBe("https://api.letterirl.com/mcp");
    expect(manifest.servers[0].healthUrl).toBe("https://api.letterirl.com/healthz");
    expect(manifest.servers[0].auth.authorizationServer).toBe(
      process.env.LETTER_IRL_OAUTH_ISSUER ??
        "https://dev-njmdyqf8n25rqgy7.us.auth0.com/"
    );
  });

  it("should advertise generate_image_fallback as fallback-only with built-in generation preferred", () => {
    const generateImageTool = buildManifest().tools.find((tool) => tool.name === "generate_image_fallback");

    expect(generateImageTool?.description).toContain("FALLBACK ONLY");
    expect(generateImageTool?.description).toContain("built-in image generation instead");
    // The old description invited eager use ("Use this even if the user has
    // not yet asked to mail it") - the demotion replaced it with an explicit
    // only-when scope. Pin the scoping clause so it cannot silently regress.
    expect(generateImageTool?.description).toContain(
      "only when built-in image generation is unavailable, has failed"
    );
  });

  it("should keep generate_image_fallback inside the first 12 registered tools for ChatGPT exposure", () => {
    const firstTwelveToolNames = new LetterIrlServer()
      .listTools()
      .slice(0, 12)
      .map((tool) => tool.name);

    expect(firstTwelveToolNames).toContain("generate_image_fallback");
  });
});

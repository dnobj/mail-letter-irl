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

  it("does not advertise any server-side image GENERATOR", () => {
    // generate_image (later generate_image_fallback) was REMOVED after the
    // #227 investigation; the HYBRID generate_image_for_mail that replaced it
    // (Addendum 3) generates only against the user's entitlements and is
    // deliberately NOT in this pin. The pin guards against the old
    // unconditional generator names returning via a bad merge or revert.
    // Decision record: docs/learnings/generate-image-removal-decision.md
    const toolNames = buildManifest().tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("generate_image_fallback");
    expect(toolNames).not.toContain("generate_image");
  });

  it("advertises the hybrid image tool honestly", () => {
    const tool = buildManifest().tools.find((t) => t.name === "generate_image_for_mail");
    // Generates only against the user's Letter IRL credits; otherwise routes
    // to built-in generation. Both halves must stay stated.
    expect(tool?.description).toContain("Letter IRL image credits");
    expect(tool?.description).toContain("built-in image generation");
    expect(tool?.description).toContain("Never refuse an image request");
  });
});

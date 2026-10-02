import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LetterIrlServer } from "../../../src/server.js";
import { buildManifest, stringifyManifest } from "../../../src/mcp/manifest.js";
import { WIDGET_DEFINITIONS } from "../../../src/mcp/registerTools.js";
import { clientProfileNamed } from "../../../src/auth/clientProfiles.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(__dirname, "../../../manifest.json");

describe("Compatibility manifest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers the previews' arriveBy only while the flag is on, as tools/list does (#535)", () => {
    const letterInput = () =>
      (buildManifest().tools.find((tool) => tool.name === "quote_and_preview_letter")!.inputSchema as {
        properties: Record<string, unknown>;
      }).properties;
    vi.stubEnv("LETTER_IRL_ARRIVE_BY_ENABLED", "");
    expect(letterInput()).not.toHaveProperty("arriveBy");
    expect(letterInput()).toHaveProperty("sendAsGift");
    vi.stubEnv("LETTER_IRL_ARRIVE_BY_ENABLED", "true");
    expect(letterInput()).toHaveProperty("arriveBy");
  });

  it("offers the letter previews' stationery only while it is offered, as tools/list does (#563)", () => {
    const input = (name: string) =>
      (buildManifest().tools.find((tool) => tool.name === name)!.inputSchema as {
        properties: Record<string, { enum?: string[] }>;
      }).properties;
    const LETTERS = ["quote_and_preview_letter", "quote_and_preview_letter_with_header_image", "quote_and_preview_letter_with_image"];
    // Off, and on without our renderer: none of the three.
    for (const [enabled, renderer] of [["", "pdf"], ["true", ""]]) {
      vi.stubEnv("LETTER_IRL_STATIONERY_ENABLED", enabled);
      vi.stubEnv("LETTER_IRL_PRINT_RENDERER", renderer);
      for (const name of LETTERS) {
        for (const key of ["stationery", "monogram", "headline"]) expect(input(name), `${name} ${key}`).not.toHaveProperty(key);
        expect(input(name), name).toHaveProperty("sendAsGift");
      }
    }
    vi.stubEnv("LETTER_IRL_STATIONERY_ENABLED", "true");
    vi.stubEnv("LETTER_IRL_PRINT_RENDERER", "pdf");
    for (const name of LETTERS) {
      expect(input(name).stationery.enum, name).toEqual(["classic", "monogram", "botanical", "celebration", "typewriter", "handwritten"]);
      expect(input(name), name).toHaveProperty("monogram");
      expect(input(name), name).toHaveProperty("headline");
    }
    // A postcard takes none, offered or not.
    for (const key of ["stationery", "monogram", "headline"]) expect(input("quote_and_preview_postcard")).not.toHaveProperty(key);
  });

  it("should mirror the runtime tool registry", () => {
    // The manifest is ChatGPT's, and ChatGPT's list is the full one: an app
    // that takes no purchases is not offered the checkouts (#475).
    const runtimeTools = new LetterIrlServer()
      .listTools(clientProfileNamed("chatgpt"))
      .map((tool) => tool.name)
      .sort();
    const manifestTools = buildManifest().tools.map((tool) => tool.name).sort();

    expect(manifestTools).toEqual(runtimeTools);
  });

  it("should mirror registered widget resources", () => {
    const manifestWidgets = buildManifest().ui.widgets;
    const runtimeWidgets = WIDGET_DEFINITIONS.map((widget) => widget.name);

    expect(manifestWidgets).toEqual(runtimeWidgets);
  });

  it("should keep the checked-in manifest.json snapshot in sync", () => {
    // Generated as production is: arrive-by (#535), stationery (#563), room to
    // write (#586) and the postcard sizes (#594) off.
    vi.stubEnv("LETTER_IRL_ARRIVE_BY_ENABLED", "");
    vi.stubEnv("LETTER_IRL_STATIONERY_ENABLED", "");
    vi.stubEnv("LETTER_IRL_ROOM_TO_WRITE_ENABLED", "");
    vi.stubEnv("LETTER_IRL_POSTCARD_SIZES_ENABLED", "");
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
    expect(tool?.description).toContain("Letter IRL image generations");
    expect(tool?.description).toContain("built-in image generation");
    // No order to the model, and no claim that a purchase includes images
    // (#476, the Plugin Directory).
    expect(tool?.description).not.toMatch(/Never refuse|letter packs|letter purchases/);
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginDir = path.resolve(__dirname, "../../../plugin");
const launchToolsPath = path.resolve(__dirname, "__snapshots__/tools-list.chatgpt-launch.json");

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const plugin = readJson(path.join(pluginDir, "plugin.json"));
const mcp = readJson(path.join(pluginDir, "mcp.json"));
const openai = plugin.extensions["com.openai"];
const listing = openai.interface;
const review = openai.review;

/** The tool names ChatGPT is served at the launch cut, from the pinned snapshot. */
function launchToolNames(): Set<string> {
  const snapshot = readJson(launchToolsPath);
  const tools: Array<{ name: string } | string> = Array.isArray(snapshot) ? snapshot : snapshot.tools ?? Object.values(snapshot)[0];
  return new Set(tools.map((tool) => (typeof tool === "string" ? tool : tool.name)));
}

// The Plugin Directory's limits (developers.openai.com/plugins/deploy/submission, read 2026-10-30).
describe("Plugin Directory package", () => {
  it("keeps the listing within the portal's limits", () => {
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(plugin.name.length).toBeLessThanOrEqual(64);
    expect(listing.displayName.length).toBeLessThanOrEqual(30);
    expect(listing.shortDescription.length).toBeLessThanOrEqual(30);
    expect(listing.longDescription.length).toBeLessThanOrEqual(4000);
    expect(listing.developerName.length).toBeLessThanOrEqual(80);
    expect(listing.defaultPrompt.length).toBeLessThanOrEqual(3);
    expect(new Set(listing.defaultPrompt).size).toBe(listing.defaultPrompt.length);
    for (const prompt of listing.defaultPrompt) {
      expect(prompt.length).toBeLessThanOrEqual(128);
      expect(prompt).not.toContain("@");
    }
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(listing[key]).toMatch(/^https:\/\/[^@\s]+$/);
      expect(listing[key].length).toBeLessThanOrEqual(1024);
    }
  });

  it("ships the icons it names, inside the package", () => {
    for (const key of ["logo", "composerIcon"]) {
      expect(listing[key]).toMatch(/^\.\/assets\//);
      const file = path.join(pluginDir, listing[key]);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
  });

  it("names a brand colour with at least 2:1 contrast on white and on #212121", () => {
    const luminance = (hex: string) => {
      const channel = (offset: number) => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    expect(listing.brandColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(contrast(listing.brandColor, "#FFFFFF")).toBeGreaterThanOrEqual(2);
    expect(contrast(listing.brandColor, "#212121")).toBeGreaterThanOrEqual(2);
  });

  it("gives exactly five positive and three negative cases, naming only tools ChatGPT is served", () => {
    const served = launchToolNames();
    expect(review.test_cases.positive).toHaveLength(5);
    expect(review.test_cases.negative).toHaveLength(3);
    for (const testCase of review.test_cases.positive) {
      expect(testCase.description).toBeTruthy();
      expect(testCase.prompt).toBeTruthy();
      expect(testCase.expected_behavior).toBeTruthy();
      expect(testCase.tools_triggered.length).toBeGreaterThan(0);
      for (const tool of testCase.tools_triggered) expect(served.has(tool)).toBe(true);
    }
    for (const testCase of review.test_cases.negative) {
      expect(testCase.description).toBeTruthy();
      expect(testCase.prompt).toBeTruthy();
    }
  });

  it("keeps reviewer credentials and instructions out of the package", () => {
    const text = JSON.stringify(plugin);
    expect(text).not.toMatch(/test_credentials|reviewer_instructions/);
    expect(JSON.stringify(mcp)).not.toMatch(/clientSecret|"headers"/);
  });

  it("declares commerce for physical mail, and the U.S. only", () => {
    expect(review.commerce).toBe(true);
    expect(review.commerce_description).toMatch(/physical/);
    // The guidelines bar selling "tokens, or credits"; packs are prepaid mailings, and say so.
    expect(review.commerce_description).not.toMatch(/\bcredits?\b|\btokens?\b/i);
    expect(listing.longDescription).not.toMatch(/\bcredits?\b|\btokens?\b/i);
    expect(openai.publication.countries).toEqual(["US"]);
  });

  it("points at the production MCP endpoint over streamable HTTP with CIMD sign-in", () => {
    const servers = Object.values(mcp.mcpServers) as Array<Record<string, any>>;
    expect(servers).toHaveLength(1);
    expect(servers[0].type).toBe("streamable-http");
    expect(servers[0].url).toBe("https://api.letterirl.com/mcp");
    expect(servers[0].extensions["com.openai"].auth).toEqual({ type: "oauth", client: { mode: "cimd" } });
  });
});

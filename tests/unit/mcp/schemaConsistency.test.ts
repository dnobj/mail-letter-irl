/**
 * Schema consistency tests for runtime MCP tools and the compatibility manifest.
 */

import { describe, it, expect } from "vitest";
import { sendLetterInputZ, quoteAndPreviewInputZ } from "../../../src/zodSchemas.js";
import { toolInputSchemas } from "../../../src/mcp/toolSchemas.js";
import { buildManifest } from "../../../src/mcp/manifest.js";

const manifest = buildManifest();

function getManifestTool(name: string) {
  return manifest.tools.find((tool) => tool.name === name);
}

describe("Schema Consistency", () => {
  describe("send_letter schema", () => {
    it("should have draftId and confirm in the runtime Zod schema", () => {
      const shape = sendLetterInputZ.shape;
      expect(shape).toHaveProperty("draftId");
      expect(shape).toHaveProperty("confirm");
      expect(shape).not.toHaveProperty("sender");
      expect(shape).not.toHaveProperty("recipient");
      expect(shape).not.toHaveProperty("bodyText");
    });

    it("should have draftId and confirm in MCP toolSchemas", () => {
      const shape = toolInputSchemas.send_letter.shape;
      expect(shape).toHaveProperty("draftId");
      expect(shape).toHaveProperty("confirm");
      expect(shape).not.toHaveProperty("sender");
      expect(shape).not.toHaveProperty("recipient");
      expect(shape).not.toHaveProperty("bodyText");
    });

    it("should have draftId and confirm in the compatibility manifest", () => {
      const sendLetterTool = getManifestTool("send_letter");
      const inputSchema = sendLetterTool?.inputSchema as Record<string, unknown>;
      const properties = inputSchema.properties as Record<string, unknown>;
      const required = inputSchema.required as string[];

      expect(sendLetterTool).toBeDefined();
      expect(required).toContain("draftId");
      expect(required).toContain("confirm");
      expect(properties).toHaveProperty("draftId");
      expect(properties).toHaveProperty("confirm");
      expect(properties).not.toHaveProperty("sender");
      expect(properties).not.toHaveProperty("recipient");
      expect(properties).not.toHaveProperty("bodyText");
    });

    it("should match required fields across runtime, MCP schemas, and manifest", () => {
      const zodRequired = Object.keys(sendLetterInputZ.shape);
      const mcpRequired = Object.keys(toolInputSchemas.send_letter.shape);
      const manifestRequired = (getManifestTool("send_letter")?.inputSchema as Record<string, unknown>)
        .required as string[];

      expect(zodRequired.sort()).toEqual(["confirm", "draftId"]);
      expect(mcpRequired.sort()).toEqual(["confirm", "draftId"]);
      expect([...manifestRequired].sort()).toEqual(["confirm", "draftId"]);
    });
  });

  describe("quote_and_preview_letter schema", () => {
    it("should have consistent fields across Zod and MCP schemas", () => {
      const zodShape = quoteAndPreviewInputZ.shape;
      const mcpShape = toolInputSchemas.quote_and_preview_letter.shape;

      expect(zodShape).toHaveProperty("recipient");
      expect(zodShape).toHaveProperty("bodyText");
      expect(zodShape).toHaveProperty("signOff");

      expect(mcpShape).toHaveProperty("recipient");
      expect(mcpShape).toHaveProperty("bodyText");
      expect(mcpShape).toHaveProperty("signOff");
    });

    it("should define quote_and_preview_letter in the compatibility manifest", () => {
      const previewTool = getManifestTool("quote_and_preview_letter");
      expect(previewTool).toBeDefined();
      expect(previewTool?.inputSchema).toBeDefined();
    });
  });
});

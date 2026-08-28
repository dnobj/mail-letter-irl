/**
 * Schema consistency tests for runtime MCP tools and the compatibility manifest.
 */

import { describe, it, expect } from "vitest";
import {
  createMailCheckoutInputZ,
  getPurchaseStatusInputZ,
  sendLetterInputZ,
  quoteAndPreviewInputZ,
  sendEligibilityZ
} from "../../../src/zodSchemas.js";
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

  describe("JIT commerce schemas", () => {
    it("registers create_mail_checkout with only the server-priced draft ID", () => {
      expect(Object.keys(createMailCheckoutInputZ.shape)).toEqual(["draftId"]);
      expect(Object.keys(toolInputSchemas.create_mail_checkout.shape)).toEqual(["draftId"]);
      const manifestTool = getManifestTool("create_mail_checkout");
      expect(manifestTool).toBeDefined();
      expect((manifestTool?.inputSchema as any).properties).not.toHaveProperty("amountCents");
      expect((manifestTool?.inputSchema as any).properties).not.toHaveProperty("priceId");
    });

    it("registers owned purchase status lookup by order ID", () => {
      expect(Object.keys(getPurchaseStatusInputZ.shape)).toEqual(["orderId"]);
      expect(Object.keys(toolInputSchemas.get_purchase_status.shape)).toEqual(["orderId"]);
      expect(getManifestTool("get_purchase_status")).toBeDefined();
    });
  });
});

/**
 * OUTPUT-schema parity between the two PUBLISHED layers.
 *
 * The cases above compare INPUT schemas only, and that gap let #278 ship
 * `displayAmount` into the MCP layer (zodSchemas.ts, served via
 * registerTools) while the JSON Schema that /manifest.json publishes
 * (schemas.ts, via LetterIrlServer.listTools) still described the old shape.
 * A consumer deriving the tool's output from the manifest dropped the field
 * and fell back to amountCents/100 - 100x wrong for a zero-decimal currency,
 * the exact bug the server-side formatting exists to prevent, live on the
 * second surface with nothing comparing them (#278 round 10, four angles).
 */
describe("published output-schema parity (#278)", () => {
  it("declares the same sendEligibility.payAndSend fields on both served layers", () => {
    const manifestTool = getManifestTool("quote_and_preview_letter");
    const payAndSend = (
      manifestTool?.outputSchema as {
        properties: {
          sendEligibility: {
            properties: { payAndSend: { properties: Record<string, unknown> } };
          };
        };
      }
    ).properties.sendEligibility.properties.payAndSend.properties;

    const zodKeys = Object.keys(sendEligibilityZ.shape.payAndSend.shape).sort();

    expect(Object.keys(payAndSend).sort()).toEqual(zodKeys);
  });
});

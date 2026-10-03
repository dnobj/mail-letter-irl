/**
 * Schema consistency tests for runtime MCP tools and the compatibility manifest.
 */

import { describe, it, expect } from "vitest";
import {
  createMailCheckoutInputZ,
  getPurchaseStatusInputZ,
  sendLetterInputZ,
  quoteAndPreviewInputZ,
  quoteAndPreviewOutputZ,
  quoteAndPreviewPostcardOutputZ,
  sendEligibilityZ, getPurchaseStatusOutputZ,
  setArrivalDateInputZ,
  setArrivalDateOutputZ,
  cancelScheduledMailInputZ,
  cancelScheduledMailOutputZ,
  requestSendOutputZ } from "../../../src/zodSchemas.js";
import {
  setArrivalDateInputSchema,
  setArrivalDateOutputSchema,
  cancelScheduledMailInputSchema,
  cancelScheduledMailOutputSchema,
  requestSendOutputSchema,
  quoteAndPreviewLetterTextOnlyInputSchema,
  quoteAndPreviewLetterWithHeaderImageInputSchema,
  quoteAndPreviewLetterWithImageInputSchema,
  quoteAndPreviewOutputSchema
} from "../../../src/schemas.js";
import { getZodInputShape } from "../../../src/mcp/registerTools.js";
import { STATIONERY_THEMES } from "../../../src/render/index.js";
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

      // sendAnotherCopy (#412) is optional in every layer: only draftId and
      // confirm are required.
      expect(zodRequired.sort()).toEqual(["confirm", "draftId", "sendAnotherCopy"]);
      expect(mcpRequired.sort()).toEqual(["confirm", "draftId", "sendAnotherCopy"]);
      expect([...manifestRequired].sort()).toEqual(["confirm", "draftId"]);
      expect(sendLetterInputZ.shape.sendAnotherCopy.isOptional()).toBe(true);
      expect(toolInputSchemas.send_letter.shape.sendAnotherCopy.isOptional()).toBe(true);
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
    it("registers create_mail_checkout with the server-priced draft ID and the another-copy flag only", () => {
      expect(Object.keys(createMailCheckoutInputZ.shape)).toEqual(["draftId", "sendAnotherCopy"]);
      expect(Object.keys(toolInputSchemas.create_mail_checkout.shape)).toEqual(["draftId", "sendAnotherCopy"]);
      expect(createMailCheckoutInputZ.shape.sendAnotherCopy.isOptional()).toBe(true);
      const manifestTool = getManifestTool("create_mail_checkout");
      expect(manifestTool).toBeDefined();
      expect((manifestTool?.inputSchema as any).required).toEqual(["draftId"]);
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
  it("declares the same get_purchase_status output fields on both served layers", () => {
    // #323 added the pack figures (letters, lettersRemaining, lettersRefunded,
    // perLetterCents, refundableAmountCents, amountRefundedCents) to the MCP
    // layer; a manifest consumer that never saw them would have no way to show
    // an operator what is left before a refund.
    const manifestTool = getManifestTool("get_purchase_status");
    const manifestKeys = Object.keys(
      (manifestTool?.outputSchema as { properties: Record<string, unknown> }).properties
    ).sort();

    expect(manifestKeys).toEqual(Object.keys(getPurchaseStatusOutputZ.shape).sort());
  });
  it("declares the letter previews' top-level output fields on both served layers, those for a card aside (#612 review round 2)", () => {
    // The manifest also lists what partitionToolResult moves to _meta for the
    // card; tools/list leaves those out. Anything else is on both, so a new
    // output field cannot land on one layer only.
    const CARD_ONLY = ['headerImageData', 'inlineImageData', 'previewHtml'];
    const manifestKeys = Object.keys(
      (getManifestTool('quote_and_preview_letter')?.outputSchema as { properties: Record<string, unknown> }).properties
    ).filter(key => !CARD_ONLY.includes(key)).sort();
    expect(manifestKeys).toEqual(Object.keys(quoteAndPreviewOutputZ.shape).sort());
    // The signature (#608) inside: the same fields, and the same reasons.
    const signature = (
      getManifestTool('quote_and_preview_letter')?.outputSchema as {
        properties: { signature: { properties: Record<string, { enum?: string[] }>; required: string[] } };
      }
    ).properties.signature;
    const served = quoteAndPreviewOutputZ.shape.signature.unwrap();
    expect(Object.keys(signature.properties).sort()).toEqual(Object.keys(served.shape).sort());
    expect([...signature.required].sort()).toEqual(Object.keys(served.shape).sort());
    expect(signature.properties.source.enum).toEqual(served.shape.source.options);
  });
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
  it("declares the same sendEligibility fields on both served layers, packPays alike (#579)", () => {
    for (const name of ["quote_and_preview_letter", "quote_and_preview_postcard"]) {
      const eligibility = (
        getManifestTool(name)?.outputSchema as {
          properties: { sendEligibility: { properties: Record<string, { const?: unknown; description?: string }> } };
        }
      ).properties.sendEligibility.properties;
      expect(Object.keys(eligibility).sort(), name).toEqual(Object.keys(sendEligibilityZ.shape).sort());
      expect(eligibility.packPays.const, name).toBe(false);
      expect(eligibility.packPays.description, name).toBe(sendEligibilityZ.shape.packPays.description);
    }
  });
  it.each([
    ["quote_and_preview_letter", quoteAndPreviewOutputZ],
    ["quote_and_preview_postcard", quoteAndPreviewPostcardOutputZ]
  ] as const)("declares the arrival dates on offer the same way on both served layers: %s (#535)", (name, outputZ) => {
    const arrivalWindow = (
      getManifestTool(name)?.outputSchema as {
        properties: { arrivalWindow: { description: string; properties: Record<string, unknown>; required: string[] } };
      }
    ).properties.arrivalWindow;
    const served = outputZ.shape.arrivalWindow;

    // Optional on the output, both dates required inside it, on each layer.
    expect(served.isOptional()).toBe(true);
    const zodKeys = Object.keys(served.unwrap().shape).sort();
    expect(zodKeys).toEqual(["earliestArrival", "latestArrival"]);
    expect(Object.keys(arrivalWindow.properties).sort()).toEqual(zodKeys);
    expect([...arrivalWindow.required].sort()).toEqual(zodKeys);
    // Both say what it is: what can be scheduled, not when this mail arrives.
    expect(served.description).toBe(arrivalWindow.description);
    expect(served.description).toMatch(/not when this mail arrives/);
  });
});

describe("set_arrival_date schema (#535)", () => {
  it("names the same inputs in the runtime Zod schema, the MCP layer and the JSON schema, with only draftId required", () => {
    const zodKeys = Object.keys(setArrivalDateInputZ.shape);
    expect(zodKeys).toEqual(["draftId", "arriveBy"]);
    expect(Object.keys(toolInputSchemas.set_arrival_date.shape)).toEqual(zodKeys);
    expect(Object.keys(setArrivalDateInputSchema.properties ?? {})).toEqual(zodKeys);
    expect(setArrivalDateInputSchema.required).toEqual(["draftId"]);
    expect(setArrivalDateInputZ.shape.draftId.isOptional()).toBe(false);
    expect(setArrivalDateInputZ.shape.arriveBy.isOptional()).toBe(true);
    expect(toolInputSchemas.set_arrival_date.shape.arriveBy.isOptional()).toBe(true);
  });

  it("names the same outputs in the runtime Zod schema and the JSON schema, schedule optional in both", () => {
    const zodKeys = Object.keys(setArrivalDateOutputZ.shape);
    expect(Object.keys(setArrivalDateOutputSchema.properties ?? {})).toEqual(zodKeys);
    expect(setArrivalDateOutputSchema.required).toEqual(zodKeys.filter((key) => key !== "schedule"));
    expect(setArrivalDateOutputZ.shape.schedule.isOptional()).toBe(true);
  });

  it("is left out of the manifest, which is generated with arrival dates off", () => {
    expect(getManifestTool("set_arrival_date")).toBeUndefined();
  });
});

describe("cancel_scheduled_mail schema (#535)", () => {
  it("names the same inputs in all three layers, both required", () => {
    const zodKeys = Object.keys(cancelScheduledMailInputZ.shape);
    expect(zodKeys).toEqual(["orderId", "confirm"]);
    expect(Object.keys(toolInputSchemas.cancel_scheduled_mail.shape)).toEqual(zodKeys);
    expect(Object.keys(cancelScheduledMailInputSchema.properties ?? {})).toEqual(zodKeys);
    expect(cancelScheduledMailInputSchema.required).toEqual(zodKeys);
    for (const key of zodKeys) {
      expect(cancelScheduledMailInputZ.shape[key as keyof typeof cancelScheduledMailInputZ.shape].isOptional(), key).toBe(false);
    }
  });

  it("names the same outputs in the runtime Zod schema and the JSON schema, all required", () => {
    const zodKeys = Object.keys(cancelScheduledMailOutputZ.shape);
    expect(Object.keys(cancelScheduledMailOutputSchema.properties ?? {})).toEqual(zodKeys);
    expect(cancelScheduledMailOutputSchema.required).toEqual(zodKeys);
  });

  it("is left out of the manifest, which is generated with arrival dates off", () => {
    expect(getManifestTool("cancel_scheduled_mail")).toBeUndefined();
  });
});

describe("request_send schema (#535)", () => {
  it("names the same outputs in the runtime Zod schema and the JSON schema, schedule optional with both dates", () => {
    const zodKeys = Object.keys(requestSendOutputZ.shape);
    expect(zodKeys).toContain("schedule");
    expect(Object.keys(requestSendOutputSchema.properties ?? {})).toEqual(zodKeys);
    expect(requestSendOutputSchema.required).toEqual(
      zodKeys.filter((key) => key !== "schedule" && key !== "paidPerSend" && key !== "mailService")
    );
    // Certified mail (#625): optional, the two services, worded alike on both layers.
    expect(requestSendOutputZ.shape.mailService.isOptional()).toBe(true);
    expect(requestSendOutputSchema.properties?.mailService).toMatchObject({
      type: "string",
      enum: ["certified", "certified_return_receipt"],
      description: requestSendOutputZ.shape.mailService.description
    });
    // Mail paid on the page (#579): optional, true only, worded alike on both layers.
    const paid = requestSendOutputZ.shape.paidPerSend;
    expect(paid.isOptional()).toBe(true);
    const paidJson = (requestSendOutputSchema.properties as Record<string, { const?: unknown; description?: string }>).paidPerSend;
    expect(paidJson.const).toBe(true);
    expect(paid.description).toBe(paidJson.description);
    // It says what packs and gift letters do not pay for, certified mail among it (#625).
    expect(paid.description).toContain('never for certified mail');
    const served = requestSendOutputZ.shape.schedule;
    expect(served.isOptional()).toBe(true);
    expect(Object.keys(served.unwrap().shape)).toEqual(["arriveBy", "mailOn"]);
    // Both dates required inside, on the served layer as on the JSON one.
    expect(served.unwrap().shape.arriveBy.isOptional()).toBe(false);
    expect(served.unwrap().shape.mailOn.isOptional()).toBe(false);
    const manifestLayer = (requestSendOutputSchema.properties as Record<string, { description?: string; required?: string[] }>).schedule;
    expect(manifestLayer.required).toEqual(["arriveBy", "mailOn"]);
    expect(served.description).toBe(manifestLayer.description);
  });
});

describe("stationery schema (#563)", () => {
  const LETTERS = [
    ["quote_and_preview_letter", quoteAndPreviewLetterTextOnlyInputSchema],
    ["quote_and_preview_letter_with_header_image", quoteAndPreviewLetterWithHeaderImageInputSchema],
    ["quote_and_preview_letter_with_image", quoteAndPreviewLetterWithImageInputSchema]
  ] as const;
  const KEYS = ["stationery", "monogram", "headline"];

  it.each(LETTERS)("declares stationery, monogram and headline on all three layers of %s, none required", (name, jsonSchema) => {
    const served = getZodInputShape(name)!;
    const properties = jsonSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    for (const key of KEYS) {
      expect(served, key).toHaveProperty(key);
      expect(served[key].isOptional(), key).toBe(true);
      expect(toolInputSchemas[name].shape, key).toHaveProperty(key);
      expect(properties, key).toHaveProperty(key);
      expect(jsonSchema.required, key).not.toContain(key);
      // The same words on the served layer and the manifest's.
      expect(properties[key].description, key).toBe(served[key].description);
    }
    expect(properties.stationery.enum).toEqual([...STATIONERY_THEMES]);
  });

  it("declares none on the postcard, on any layer", () => {
    for (const key of KEYS) {
      expect(getZodInputShape("quote_and_preview_postcard"), key).not.toHaveProperty(key);
      expect(toolInputSchemas.quote_and_preview_postcard.shape, key).not.toHaveProperty(key);
    }
  });

  it("declares the letter previews' stationery output the same way on both served layers, optional", () => {
    const served = quoteAndPreviewOutputZ.shape.stationery;
    expect(served.isOptional()).toBe(true);
    const manifestLayer = (quoteAndPreviewOutputSchema.properties as Record<string, {
      description?: string; properties: Record<string, { enum?: string[] }>; required: string[];
    }>).stationery;
    const zodKeys = Object.keys(served.unwrap().shape);
    expect(zodKeys).toEqual(["theme", "dateLine", "monogram", "headline", "source"]);
    expect(Object.keys(manifestLayer.properties)).toEqual(zodKeys);
    expect(manifestLayer.required).toEqual(["theme", "source"]);
    expect(manifestLayer.properties.theme.enum).toEqual([...STATIONERY_THEMES]);
    expect(served.description).toBe(manifestLayer.description);
    expect(quoteAndPreviewPostcardOutputZ.shape).not.toHaveProperty("stationery");
  });
});

/**
 * Compile-time proof that every tool's output type and its served output
 * schema describe the same thing, in BOTH directions.
 *
 * ## Direction 1: declared-but-not-produced (issue #197)
 *
 * `sendEligibility` was added to the letter preview output schema with issue
 * #69's Pay & Send foundation, and to one of the two builders that produce
 * that output. The other builder's interface never declared it, so nothing
 * complained: the object literal matched its own interface, the build passed,
 * and every letter preview was rejected at runtime by the MCP layer with
 * `-32602 Required field missing: sendEligibility`. Because the draft id
 * arrives in that same response, no letter could be sent at all.
 *
 * ## Direction 2: produced-but-not-declared (issue #257)
 *
 * The quieter failure. A handler computes a field, the served schema does not
 * declare it, and the field never reaches the widget - silently, with no error
 * anywhere. It has happened three times: the letter cards' images (fixed by
 * routing them through `_meta`), the postcard's flat address fields, and
 * `originalAddress`/`verifiedAddress` on the validation objects, which left
 * the letter card's address window empty on every preview ever rendered.
 *
 * Where the drop happens is worth being precise about, because it dictates
 * what a guard can be. At `@modelcontextprotocol/sdk` 1.29.0 the server does
 * NOT strip: `registerTools` hands the SDK a raw zod shape, and the SDK's
 * `validateToolOutput` calls `safeParseAsync` but discards `parseResult.data`,
 * so the unstripped result goes on the wire. The drop is client-side, when
 * ChatGPT filters `structuredContent` against the JSON Schema published on
 * `tools/list`. A server-side runtime assertion would therefore never
 * reproduce it - the check has to be this: a static comparison of what the
 * type produces against what the schema declares.
 *
 * ## Why this file lives in `src/`
 *
 * `tsconfig.json` includes only `src`, so a type assertion written in a test
 * is never type-checked. This file is types only and emits no runtime code.
 * It exists to fail `npm run build` the moment the two sides diverge, which is
 * the moment the mistake is cheap to fix.
 */

import type { z } from "zod";
import type { McpToolDefinition } from "./types.js";
import type {
  quoteAndPreviewOutputZ,
  quoteAndPreviewPostcardOutputZ,
  sendLetterOutputZ,
  sendPostcardOutputZ,
  createMailCheckoutOutputZ,
  getPurchaseStatusOutputZ,
  getOrderStatusOutputZ,
  getAccountBalanceOutputZ,
  listOrdersOutputZ,
  setReturnAddressOutputZ,
  getReturnAddressOutputZ,
  clearReturnAddressOutputZ,
  submitFeatureRequestOutputZ,
  getStartedOutputZ,
  uploadImageOutputZ,
  generateImageForMailOutputZ,
  confirmUploadedImageOutputZ
} from "../zodSchemas.js";
import type {
  quoteAndPreviewLetterTextOnlyTool,
  quoteAndPreviewLetterWithHeaderImageTool,
  quoteAndPreviewLetterWithImageTool,
  sendLetterTool,
  createMailCheckoutTool,
  getPurchaseStatusTool,
  getOrderStatusTool,
  getAccountBalanceTool,
  listOrdersTool,
  setReturnAddressTool,
  getReturnAddressTool,
  clearReturnAddressTool,
  quoteAndPreviewPostcardTool,
  sendPostcardTool,
  submitFeatureRequestTool,
  getStartedTool,
  uploadImageTool,
  generateImageForMailTool,
  confirmUploadedImageTool
} from "../tools/index.js";

// ============================================================================
// Machinery
// ============================================================================

/**
 * The output type a tool actually promises, read off the registered tool
 * object rather than an interface imported by name. Tying the check to the
 * registration means it cannot drift: if a handler's return type changes, the
 * thing being checked changes with it.
 */
type OutputOf<Tool> = Tool extends McpToolDefinition<any, infer Output> ? Output : never;

/** Keys the schema requires that the tool's output type never carries. */
type MissingKeys<Output, Schema> = Exclude<keyof Schema, keyof Output>;

/**
 * The fields `partitionToolResult` (src/mcp/registerTools.ts) removes from
 * structuredContent. Six are forwarded into `_meta` for the widget; three are
 * full-quality originals the draft already holds and are dropped from both
 * channels. Either way they are deliberately absent from the served schema,
 * so they are the one legitimate way to produce a field the schema omits.
 *
 * Keep in step with partitionToolResult. The widget data-contract test
 * (tests/unit/mcp/widgetResources.test.ts) derives its copy from the runtime
 * function; this list cannot, because types cannot read a value.
 */
type MetaPartitioned =
  | "previewHtml"
  | "previewFrontHtml"
  | "previewBackHtml"
  | "headerImagePreview"
  | "inlineImagePreview"
  | "generatedImagePreview"
  | "headerImageData"
  | "inlineImageData"
  | "frontImageData";

type UndeclaredKeys<Output, Schema> = Exclude<keyof Output, keyof Schema | MetaPartitioned>;

/**
 * Resolves to `true` when every key the tool produces is either declared by
 * the schema or partitioned into `_meta`; otherwise resolves to an error
 * object whose `undeclaredKeys` member names the offenders in the compiler
 * output.
 */
type NoUndeclared<Output, Schema> = [UndeclaredKeys<Output, Schema>] extends [never]
  ? true
  : {
      error: "This tool produces field(s) its served output schema does not declare, so ChatGPT will drop them. Declare them in zodSchemas.ts, route them through partitionToolResult, or stop producing them.";
      undeclaredKeys: UndeclaredKeys<Output, Schema>;
    };

/**
 * Both directions in one result: `true`, or an error object naming the fields.
 * Direction 1 first, because a type missing a required field also fails to be
 * assignable and its message should say so rather than blaming stray keys.
 */
type BothDirections<Schema, Tool> = OutputOf<Tool> extends Schema
  ? NoUndeclared<OutputOf<Tool>, Schema>
  : {
      error: "This tool's served output schema requires field(s) its output type does not carry, so the MCP layer will reject every call with -32602. Add them to the output type, or make them optional in zodSchemas.ts.";
      missingKeys: MissingKeys<OutputOf<Tool>, Schema>;
    };

/**
 * Turns a failure into a build error. Applied per tool below rather than
 * inside a generic alias: the constraint can only be decided once `Schema`
 * and `Tool` are concrete, and TypeScript checks a generic alias eagerly.
 */
type Conforms<Passed extends true> = Passed;

// ============================================================================
// Every registered tool, both directions
//
// One entry per tool in registerTools' zodOutputSchemas map. A new tool with
// no entry here is the gap this file exists to close, so
// tests/unit/mcp/registerTools.test.ts pins the count.
// ============================================================================

export type LetterTextOnlyConforms = Conforms<
  BothDirections<z.infer<typeof quoteAndPreviewOutputZ>, typeof quoteAndPreviewLetterTextOnlyTool>
>;
export type LetterWithHeaderImageConforms = Conforms<
  BothDirections<z.infer<typeof quoteAndPreviewOutputZ>, typeof quoteAndPreviewLetterWithHeaderImageTool>
>;
export type LetterWithImageConforms = Conforms<
  BothDirections<z.infer<typeof quoteAndPreviewOutputZ>, typeof quoteAndPreviewLetterWithImageTool>
>;
export type SendLetterConforms = Conforms<
  BothDirections<z.infer<typeof sendLetterOutputZ>, typeof sendLetterTool>
>;
export type CreateMailCheckoutConforms = Conforms<
  BothDirections<z.infer<typeof createMailCheckoutOutputZ>, typeof createMailCheckoutTool>
>;
export type GetPurchaseStatusConforms = Conforms<
  BothDirections<z.infer<typeof getPurchaseStatusOutputZ>, typeof getPurchaseStatusTool>
>;
export type GetOrderStatusConforms = Conforms<
  BothDirections<z.infer<typeof getOrderStatusOutputZ>, typeof getOrderStatusTool>
>;
export type GetAccountBalanceConforms = Conforms<
  BothDirections<z.infer<typeof getAccountBalanceOutputZ>, typeof getAccountBalanceTool>
>;
export type ListOrdersConforms = Conforms<
  BothDirections<z.infer<typeof listOrdersOutputZ>, typeof listOrdersTool>
>;
export type SetReturnAddressConforms = Conforms<
  BothDirections<z.infer<typeof setReturnAddressOutputZ>, typeof setReturnAddressTool>
>;
export type GetReturnAddressConforms = Conforms<
  BothDirections<z.infer<typeof getReturnAddressOutputZ>, typeof getReturnAddressTool>
>;
export type ClearReturnAddressConforms = Conforms<
  BothDirections<z.infer<typeof clearReturnAddressOutputZ>, typeof clearReturnAddressTool>
>;
export type PostcardConforms = Conforms<
  BothDirections<z.infer<typeof quoteAndPreviewPostcardOutputZ>, typeof quoteAndPreviewPostcardTool>
>;
export type SendPostcardConforms = Conforms<
  BothDirections<z.infer<typeof sendPostcardOutputZ>, typeof sendPostcardTool>
>;
export type SubmitFeatureRequestConforms = Conforms<
  BothDirections<z.infer<typeof submitFeatureRequestOutputZ>, typeof submitFeatureRequestTool>
>;
export type GetStartedConforms = Conforms<
  BothDirections<z.infer<typeof getStartedOutputZ>, typeof getStartedTool>
>;
export type UploadImageConforms = Conforms<
  BothDirections<z.infer<typeof uploadImageOutputZ>, typeof uploadImageTool>
>;
export type GenerateImageForMailConforms = Conforms<
  BothDirections<z.infer<typeof generateImageForMailOutputZ>, typeof generateImageForMailTool>
>;
export type ConfirmUploadedImageConforms = Conforms<
  BothDirections<z.infer<typeof confirmUploadedImageOutputZ>, typeof confirmUploadedImageTool>
>;

/**
 * Compile-time proof that each preview tool's output type satisfies the schema
 * its tool is registered with.
 *
 * Issue #197. `sendEligibility` was added to the letter preview output schema
 * with issue #69's Pay & Send foundation, and to one of the two builders that
 * produce that output. The other builder's interface never declared it, so
 * nothing complained: the object literal matched its own interface, the build
 * passed, and every letter preview was rejected at runtime by the MCP layer
 * with `-32602 Required field missing: sendEligibility`. Because the draft id
 * arrives in that same response, no letter could be sent at all.
 *
 * Nothing caught it because the checks sit on either side of the gap. The zod
 * schemas describe what the wire must carry; the interfaces describe what the
 * builders produce; and until this file, no rule connected them. Tests cannot
 * do it either - `tsconfig.json` includes only `src`, so a type assertion in a
 * test is never type-checked.
 *
 * This file is types only and emits no runtime code. It exists to fail
 * `npm run build` the moment a builder's output type stops satisfying its
 * schema, which is the moment the mistake is cheap to fix.
 */

import type { z } from "zod";
import type {
  quoteAndPreviewOutputZ,
  quoteAndPreviewPostcardOutputZ
} from "../zodSchemas.js";
import type { LetterQuoteOutput } from "../tools/letterHelpers.js";
import type { QuoteAndPreviewOutput } from "../tools/quoteAndPreview.js";
import type { QuoteAndPreviewPostcardOutput } from "../tools/quoteAndPreviewPostcard.js";

/**
 * Fails to compile unless `Output` carries everything `Schema` requires.
 * Extra properties are allowed: previewHtml and the image previews are moved
 * into `_meta` by partitionToolResult and are deliberately absent from the
 * structured output schema.
 */
type MustSatisfy<Schema, Output extends Schema> = Output;

/** The three letter preview tools all register quoteAndPreviewOutputZ. */
export type LetterHelpersConforms = MustSatisfy<
  z.infer<typeof quoteAndPreviewOutputZ>,
  LetterQuoteOutput
>;

export type QuoteAndPreviewConforms = MustSatisfy<
  z.infer<typeof quoteAndPreviewOutputZ>,
  QuoteAndPreviewOutput
>;

export type PostcardConforms = MustSatisfy<
  z.infer<typeof quoteAndPreviewPostcardOutputZ>,
  QuoteAndPreviewPostcardOutput
>;

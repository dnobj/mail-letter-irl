/**
 * generate_image_for_mail - the hybrid image tool (issue #227; decision
 * record docs/learnings/generate-image-removal-decision.md, Addendum 3).
 *
 * Three modes, decided server-side per call:
 *
 * 1. GENERATED - the user has Letter IRL image-generation credits (granted
 *    by pack purchases, JIT orders, or the one-time starter grant) and the
 *    global daily ceiling has room: reserve a credit atomically, generate
 *    via the OpenAI Images API, and return the image in-turn. This is the
 *    only way an image can appear inside a mention-scoped turn, where the
 *    host genuinely withholds ChatGPT's built-in image_gen (on-device
 *    proven; see the decision record's mechanism correction).
 *
 * 2. REDIRECT - no credits, ceiling reached, generation unconfigured, or
 *    generation failed: return routing guidance instead. The widget shows
 *    an explanation plus a copy-ready prompt so the user can resend it
 *    without mentioning Letter IRL (widget-initiated sendFollowUpMessage
 *    was proven to false-positive on the native app, so the copy field is
 *    the honest affordance).
 *
 * The tool NEVER hard-fails the model on quota or provider trouble - every
 * failure path lands on redirect mode, because built-in generation always
 * exists one unmentioned message away.
 */

import sharp from "sharp";
import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import { widgetTemplateUri } from "../mcp/widgetUris.js";
import {
  generateImage,
  ImageGenerationError,
  type ImageContext
} from "../services/imageGenerationService.js";
import {
  commitGenerationReservation,
  countGenerationsToday,
  ensureStarterGrant,
  markGenerationDispatched,
  markGenerationReservationAmbiguous,
  releaseGenerationReservation,
  reserveGeneration
} from "../services/imageGenerationLimitService.js";
import { isTempImageStoreConfigured, storeImage } from "../services/tempImageStore.js";

interface GenerateImageForMailInput {
  prompt?: string;
  context?: string;
}

interface GenerateImageForMailOutput {
  mode: "generated" | "redirect";
  status: string;
  message: string;
  suggestedNextStep: string;
  prompt?: string;
  generatedImagePreview?: string;
  generatedImageUrl?: string;
  generationsRemaining?: number;
}

const PREVIEW_CONFIG = { maxWidth: 400, jpegQuality: 60 } as const;

function dailyCeiling(): number {
  // 0 is a KILL SWITCH (block all generation), not "disabled" - an operator
  // zeroing the ceiling during a spend incident must stop spend, not open it.
  const parsed = Number.parseInt(
    process.env.LETTER_IRL_IMAGE_DAILY_CEILING ?? "200",
    10
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 200;
}

async function createPreview(base64Data: string): Promise<string> {
  const buffer = Buffer.from(base64Data, "base64");
  const preview = await sharp(buffer)
    .resize(PREVIEW_CONFIG.maxWidth, undefined, {
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: PREVIEW_CONFIG.jpegQuality })
    .toBuffer();
  return preview.toString("base64");
}

function buildTempImageUrl(token: string): string {
  const baseUrl =
    process.env.LETTER_IRL_API_URL ||
    process.env.LETTER_IRL_PUBLIC_BASE_URL ||
    "https://api.letterirl.com";
  return `${baseUrl}/api/temp-image/${token}`;
}

function buildNextStep(context: string | undefined, imageUrl: string): string {
  switch (context) {
    case "postcard":
      return `IMPORTANT: Now call quote_and_preview_postcard and set imageUrl to "${imageUrl}"`;
    case "header_image":
      return `IMPORTANT: Now call quote_and_preview_letter_with_header_image and set imageUrl to "${imageUrl}"`;
    case "inline_image":
      return `IMPORTANT: Now call quote_and_preview_letter_with_image and set imageUrl to "${imageUrl}"`;
    default:
      return `IMPORTANT: Pass imageUrl "${imageUrl}" to quote_and_preview_postcard or a letter preview tool.`;
  }
}

function redirectOutput(
  input: GenerateImageForMailInput,
  statusCode: string,
  userNote: string
): GenerateImageForMailOutput {
  return {
    mode: "redirect",
    prompt: input?.prompt,
    status: statusCode,
    message: userNote,
    suggestedNextStep:
      "Relay the card's guidance briefly: the user can copy the prompt shown and send it WITHOUT mentioning Letter IRL, and ChatGPT's built-in image generation will create it free. Do not apologize at length."
  };
}

async function releaseReservedGeneration(
  context: ToolContext,
  userId: string,
  reservationId: string | undefined,
  reason: string
): Promise<void> {
  if (!reservationId) return;
  try {
    await releaseGenerationReservation(userId, reservationId, reason);
  } catch {
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "generate_image.reservation_release_failed",
        errorClass: "database_error"
      },
      "Failed to release image generation reservation"
    );
  }
}

async function preserveAmbiguousGeneration(
  context: ToolContext,
  userId: string,
  reservationId: string | undefined,
  reason: string,
  providerRequestId?: string
): Promise<void> {
  if (!reservationId) return;
  try {
    await markGenerationReservationAmbiguous(userId, reservationId, reason, providerRequestId);
  } catch {
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "generate_image.reservation_reconciliation_failed",
        errorClass: "database_error"
      },
      "Image generation reservation requires maintenance reconciliation"
    );
  }
}

async function handler(
  input: GenerateImageForMailInput,
  context: ToolContext
): Promise<GenerateImageForMailOutput> {
  const userId = context.user.userId || "default-user";
  const prompt = input?.prompt?.trim();

  if (!prompt) {
    return redirectOutput(
      input,
      "no_prompt",
      "Letter IRL needs a description to route an image request. ChatGPT's built-in generation is always available without mentioning Letter IRL."
    );
  }

  if (!process.env.OPENAI_API_KEY || !isTempImageStoreConfigured()) {
    // Preflight BOTH paid-path dependencies before any credit is reserved: a
    // missing temp store would otherwise burn the credit and the provider
    // charge, then fail at persistence (PR #247 review blocker).
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "generate_image.unconfigured",
        errorClass: "configuration_error",
        missingKey: !process.env.OPENAI_API_KEY,
        missingTempStore: !isTempImageStoreConfigured()
      },
      "Image generation not configured; degrading to redirect"
    );
    return redirectOutput(
      input,
      "generation_unconfigured",
      "Letter IRL in-turn generation is not configured here. ChatGPT's built-in generation creates the image free - resend the prompt without mentioning Letter IRL."
    );
  }

  // One-time starter grant per user - idempotent by the entitlement table's
  // (source_type, source_reference_id) uniqueness, so replays are no-ops.
  try {
    await ensureStarterGrant(userId);
  } catch {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "generate_image.starter_grant_failed",
        errorClass: "database_error"
      },
      "Starter grant check failed; continuing with existing quota"
    );
  }

  // Global daily ceiling: bounded worst-case spend regardless of how many
  // accounts exist. Past the ceiling everyone degrades to redirect mode.
  try {
    const ceiling = dailyCeiling();
    if (ceiling === 0 || (await countGenerationsToday()) >= ceiling) {
      context.logger.warn(
        { correlationId: context.correlationId, event: "generate_image.daily_ceiling_reached" },
        "Global image generation ceiling reached"
      );
      return redirectOutput(
        input,
        "daily_ceiling_reached",
        "Letter IRL's in-turn generation is taking a breather today. ChatGPT's built-in generation creates the image free - resend the prompt without mentioning Letter IRL."
      );
    }
  } catch {
    // Ceiling check trouble must not block paid users; fall through.
  }

  let reservation: Awaited<ReturnType<typeof reserveGeneration>>;
  try {
    reservation = await reserveGeneration(userId);
  } catch {
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "generate_image.reserve_failed",
        errorClass: "database_error"
      },
      "Credit reservation failed; degrading to redirect"
    );
    return redirectOutput(
      input,
      "generation_failed",
      "Letter IRL's in-turn generation hit a snag and no credit was used. ChatGPT's built-in generation creates the image free - resend the prompt without mentioning Letter IRL."
    );
  }
  if (!reservation.reserved) {
    return redirectOutput(
      input,
      "no_credits",
      "This account has no Letter IRL image generations left. ChatGPT's built-in generation creates the image free - resend the prompt without mentioning Letter IRL. Letter packs and letter purchases include in-turn generations."
    );
  }

  let providerDispatched = false;
  let providerSucceeded = false;
  let providerRequestId: string | undefined;
  try {
    const result = await generateImage(prompt, {
      context: input.context as ImageContext | undefined,
      beforeDispatch: async () => {
        if (!reservation.reservationId) {
          throw new Error("Image generation reservation is missing");
        }
        const dispatched = await markGenerationDispatched(userId, reservation.reservationId);
        if (!dispatched) {
          throw new Error("Image generation reservation expired before provider dispatch");
        }
        providerDispatched = true;
      }
    });
    providerSucceeded = true;
    providerRequestId = result.providerRequestId;

    // Provider usage is billable once generation succeeds; consume the
    // reservation before any downstream persistence can fail-and-retry free.
    if (reservation.reservationId) {
      const committed = result.providerRequestId
        ? await commitGenerationReservation(reservation.reservationId, result.providerRequestId)
        : await commitGenerationReservation(reservation.reservationId);
      if (!committed) {
        throw new Error("Image generation outcome could not be persisted");
      }
    }

    const previewBase64 = await createPreview(result.base64Data);
    const token = await storeImage(result.base64Data);
    const imageUrl = buildTempImageUrl(token);
    const suggestedNextStep = buildNextStep(input.context, imageUrl);

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "generate_image.success",
        generationsRemaining: reservation.remaining
      },
      "Image generated successfully"
    );

    return {
      mode: "generated",
      prompt,
      status: "generated",
      message: `Image generated using 1 Letter IRL image credit (${reservation.remaining} remaining). ${suggestedNextStep}`,
      suggestedNextStep,
      generatedImagePreview: previewBase64,
      generatedImageUrl: imageUrl,
      generationsRemaining: reservation.remaining
    };
  } catch (error) {
    const ambiguousProviderOutcome =
      providerSucceeded ||
      (providerDispatched &&
        (!(error instanceof ImageGenerationError) || error.outcome === "ambiguous"));
    if (ambiguousProviderOutcome) {
      await preserveAmbiguousGeneration(
        context,
        userId,
        reservation.reservationId,
        providerSucceeded ? "provider_succeeded_persistence_unknown" : "provider_outcome_unknown",
        // Prefer the id captured from a successful provider response (lost on
        // the commit-failure path if we only read it off ImageGenerationError).
        providerRequestId ??
          (error instanceof ImageGenerationError ? error.providerRequestId : undefined)
      );
    } else {
      await releaseReservedGeneration(
        context,
        userId,
        reservation.reservationId,
        providerDispatched ? "provider_definite_failure" : "pre_dispatch_failure"
      );
    }

    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "generate_image.failed",
        errorClass: error instanceof ImageGenerationError ? "provider_error" : "unknown_error"
      },
      "Image generation failed; degrading to redirect"
    );

    return redirectOutput(
      input,
      "generation_failed",
      ambiguousProviderOutcome
        ? "Letter IRL's in-turn generation hit a snag. If a credit was used without an image arriving, maintenance reconciles it automatically. ChatGPT's built-in generation creates the image free - resend the prompt without mentioning Letter IRL."
        : "Letter IRL's in-turn generation hit a snag and no credit was used. ChatGPT's built-in generation creates the image free - resend the prompt without mentioning Letter IRL."
    );
  }
}

export const generateImageForMailTool: McpToolDefinition<
  GenerateImageForMailInput,
  GenerateImageForMailOutput
> = {
  name: "generate_image_for_mail",
  title: "Create or route an image for mail",
  description:
    "Call this whenever the user asks Letter IRL to generate, create, draw, or make an image. When the user has Letter IRL image credits (included with letter packs and letter purchases, plus a small starter allowance) it generates the image immediately and returns an imageUrl for postcard and letter previews. Without credits it returns guidance: ChatGPT's built-in image generation creates images free when the request does not mention Letter IRL. Never refuse an image request - call this tool and follow its response.",
  readOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The image the user asked for, in their words."
      },
      context: {
        type: "string",
        enum: ["postcard", "header_image", "inline_image"],
        description: "Optional mail context."
      }
    },
    required: []
  },
  outputSchema: {
    type: "object",
    required: ["mode", "status", "message", "suggestedNextStep"],
    properties: {
      mode: { type: "string", enum: ["generated", "redirect"] },
      status: { type: "string" },
      message: { type: "string" },
      suggestedNextStep: { type: "string" },
      prompt: { type: "string" },
      generatedImageUrl: { type: "string" },
      generationsRemaining: { type: "integer" }
    }
  },
  meta: {
    "openai/outputTemplate": widgetTemplateUri("ImageRoutingCard"),
    "openai/toolInvocation/invoking": "Working on the image...",
    "openai/toolInvocation/invoked": "Image request handled",
    readOnlyHint: false
  },
  handler
};

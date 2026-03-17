/**
 * Submit Feature Request Tool
 *
 * Allows users to submit feature requests directly through ChatGPT.
 * ChatGPT will proactively suggest this tool when users ask for
 * functionality that doesn't exist yet.
 *
 * User Story: US-FEEDBACK-01
 */

import { McpToolDefinition, ToolContext } from "../contracts/types.js";
import {
  submitFeatureRequestInputSchema,
  submitFeatureRequestOutputSchema
} from "../schemas.js";
import {
  submitFeatureRequest,
  FeatureRequestCategory
} from "../services/featureRequestService.js";

interface SubmitFeatureRequestInput {
  title: string;
  description: string;
  category?: FeatureRequestCategory;
  attemptedAction?: string;
  contactEmail?: string;
  okToContact?: boolean;
}

interface SubmitFeatureRequestOutput {
  success: boolean;
  requestId: string;
  message: string;
  category: string;
}

async function handler(
  input: SubmitFeatureRequestInput,
  context: ToolContext
): Promise<SubmitFeatureRequestOutput> {
  const userId = context.user.userId;

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "feature_request.submit.start",
      title: input.title,
      category: input.category || "other",
      hasAttemptedAction: !!input.attemptedAction
    },
    "Submitting feature request"
  );

  try {
    const result = await submitFeatureRequest(userId, {
      title: input.title,
      description: input.description,
      category: input.category,
      attemptedAction: input.attemptedAction,
      contactEmail: input.contactEmail,
      okToContact: input.okToContact
    });

    context.logger.info(
      {
        correlationId: context.correlationId,
        event: "feature_request.submit.success",
        requestId: result.requestId,
        category: result.category
      },
      "Feature request submitted successfully"
    );

    return {
      success: true,
      requestId: result.requestId,
      message:
        "Thank you for your feature request! We've recorded your feedback and will review it. " +
        "Your input helps us improve Letter IRL.",
      category: result.category
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "feature_request.submit.failed",
        errorMessage
      },
      "Feature request submission failed"
    );

    // Re-throw with user-friendly message
    throw new Error(errorMessage);
  }
}

export const submitFeatureRequestTool: McpToolDefinition<
  SubmitFeatureRequestInput,
  SubmitFeatureRequestOutput
> = {
  name: "submit_feature_request",
  description: "Submit a feature request to the Letter IRL team for unsupported capabilities or product improvements. Use this for missing mail formats, workflows, or integrations, not for billing or bug support.",
  readOnly: false,
  inputSchema: submitFeatureRequestInputSchema,
  outputSchema: submitFeatureRequestOutputSchema,
  meta: {
    "openai/toolInvocation/invoking": "Submitting feature request…",
    "openai/toolInvocation/invoked": "Feature request submitted",
    readOnlyHint: false,
    idempotentHint: false
  },
  handler
};

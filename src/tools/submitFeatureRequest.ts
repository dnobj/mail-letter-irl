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
  description: `Submit a feature request to the Letter IRL team.

USE THIS TOOL WHEN:
- User asks about sending letters internationally (Canada, UK, etc.)
- User asks about sending greeting cards, holiday cards, or other mail formats
- User asks about features that don't exist (bulk mail, templates, address book, scheduling)
- User asks about integrations with other services
- User expresses frustration that something isn't possible
- User says "I wish I could..." or "Can you add..."

DO NOT USE THIS TOOL FOR:
- Bug reports (direct user to support)
- Billing or payment issues (direct user to support)
- Questions about existing features (answer their question instead)
- General feedback that isn't a feature request

CATEGORIES:
- new_feature: Brand new functionality
- improvement: Enhancement to existing features
- integration: Connecting with other services
- mail_type: New mail formats (greeting cards, packages, etc.)
- international: Sending mail outside the US
- other: Anything else

TIPS:
- Include the attemptedAction field when the user was trying to do something specific
- Summarize the user's request clearly in the title
- Include context in the description about why this would be valuable
- Ask if the user would like to be contacted about the feature (okToContact)
- If they say yes, ask for their preferred email or use their account email`,
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

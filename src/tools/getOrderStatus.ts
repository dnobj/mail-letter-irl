import {
  McpToolDefinition,
  ToolContext,
  OrderRecord
} from "../contracts/types.js";
import {
  getOrderStatusInputSchema,
  getOrderStatusOutputSchema
} from "../schemas.js";

interface GetOrderStatusInput {
  orderId?: string;
}

interface GetOrderStatusOutput {
  orderId: string;
  currentStatus: string;
  statusTimeline: { timestampISO: string; statusText: string }[];
  recipientSummary: { name: string; city: string; state: string };
  previewThumbnailHtml: string;
  canSendFollowUp?: boolean;
  followUpSuggestedPrompt?: string;
}


function selectOrder(
  orders: OrderRecord[],
  orderId?: string
): OrderRecord | undefined {
  if (orderId) {
    return orders.find((order) => order.orderId === orderId);
  }
  return [...orders].sort((a, b) => {
    const aTime = a.statusTimeline[a.statusTimeline.length - 1]?.timestampISO ?? "";
    const bTime = b.statusTimeline[b.statusTimeline.length - 1]?.timestampISO ?? "";
    return bTime.localeCompare(aTime);
  })[0];
}

async function handler(
  input: GetOrderStatusInput,
  context: ToolContext
): Promise<GetOrderStatusOutput> {
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "status.lookup.start",
      hasOrderId: Boolean(input.orderId)
    },
    "Checking order status"
  );
  const order = selectOrder(context.user.orders, input.orderId);
  if (!order) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "status.lookup.not_found"
      },
      "No matching order found"
    );
    throw new Error("No matching order found for this user.");
  }

  const previewThumbnailHtml =
    order.previewFirstPageHtml ??
    "<div style=\"padding:1rem; border:1px solid #ccc; font-family:serif;\">Preview unavailable in prototype.</div>";

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "status.lookup.success",
      orderId: order.orderId,
      currentStatus: order.currentStatus
    },
    "Resolved order status"
  );

  return {
    orderId: order.orderId,
    currentStatus: order.currentStatus,
    statusTimeline: order.statusTimeline,
    recipientSummary: order.recipientSummary,
    previewThumbnailHtml,
    canSendFollowUp: true,
    followUpSuggestedPrompt: `Write a follow-up letter to ${order.recipientSummary.name}.`
  };
}

export const getOrderStatusTool: McpToolDefinition<
  GetOrderStatusInput,
  GetOrderStatusOutput
> = {
  name: "get_order_status",
  description: "Retrieve the latest status timeline for a letter order. If no orderId is provided, returns the most recent order.",
  readOnly: true,
  inputSchema: getOrderStatusInputSchema,
  outputSchema: getOrderStatusOutputSchema,
  meta: {
    "openai/toolInvocation/invoking": "Checking letter status…",
    "openai/toolInvocation/invoked": "Latest status",
    readOnlyHint: true
  },
  handler
};

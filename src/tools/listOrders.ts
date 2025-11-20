import {
  McpToolDefinition,
  ToolContext,
  OrderRecord
} from "../contracts/types.js";
import {
  listOrdersInputSchema,
  listOrdersOutputSchema
} from "../schemas.js";

interface ListOrdersInput {
  limit?: number;
}

interface OrderSummary {
  orderId: string;
  recipient: { name: string; city: string; state: string };
  status: string;
  sentAt: string;
}

interface ListOrdersOutput {
  orders: OrderSummary[];
  total: number;
}

async function handler(
  input: ListOrdersInput,
  context: ToolContext
): Promise<ListOrdersOutput> {
  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "list.orders.start",
      limit: input.limit
    },
    "Listing user orders"
  );

  // Sort orders by most recent first
  const sortedOrders = [...context.user.orders].sort((a, b) => {
    const aTime = a.statusTimeline[a.statusTimeline.length - 1]?.timestampISO ?? "";
    const bTime = b.statusTimeline[b.statusTimeline.length - 1]?.timestampISO ?? "";
    return bTime.localeCompare(aTime);
  });

  // Apply limit if specified (default to 10)
  const limit = input.limit ?? 10;
  const limitedOrders = sortedOrders.slice(0, limit);

  // Map to summary format
  const orderSummaries: OrderSummary[] = limitedOrders.map((order: OrderRecord) => ({
    orderId: order.orderId,
    recipient: order.recipientSummary,
    status: order.currentStatus,
    sentAt: order.statusTimeline[0]?.timestampISO ?? ""
  }));

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "list.orders.success",
      count: orderSummaries.length,
      total: context.user.orders.length
    },
    "Listed user orders"
  );

  return {
    orders: orderSummaries,
    total: context.user.orders.length
  };
}

export const listOrdersTool: McpToolDefinition<
  ListOrdersInput,
  ListOrdersOutput
> = {
  name: "list_orders",
  description: "List the user's letter orders (most recent first). Returns order IDs that can be used with get_order_status.",
  readOnly: true,
  inputSchema: listOrdersInputSchema,
  outputSchema: listOrdersOutputSchema,
  meta: {
    "openai/toolInvocation/invoking": "Loading your orders…",
    "openai/toolInvocation/invoked": "Order history",
    readOnlyHint: true
  },
  handler
};

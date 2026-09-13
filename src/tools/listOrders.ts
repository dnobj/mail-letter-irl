import {
  McpToolDefinition,
  ToolContext,
  OrderRecord
} from "../contracts/types.js";
import {
  listOrdersInputSchema,
  listOrdersOutputSchema
} from "../schemas.js";
import { listPackPurchases, type PackPurchaseSummary } from "../services/commerceService.js";

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
  packPurchases: PackPurchaseSummary[];
  packPurchaseTotal: number;
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

  // Letter-pack purchases live in the orders table, not on the user record,
  // and were invisible here until #365: the model was asked for "my most
  // recent pack purchase" and could not find it, because the only place its
  // id appeared was the checkout card, which the model does not see.
  let packs: { purchases: PackPurchaseSummary[]; total: number };
  try {
    packs = await listPackPurchases(context.user.userId, limit);
  } catch (error) {
    // Fail closed rather than answer "no pack purchases": an empty list here
    // is a claim the customer would believe.
    context.logger.error(
      {
        correlationId: context.correlationId,
        event: "list.orders.packs_failed",
        errorClass: error instanceof Error ? error.name : "unknown"
      },
      "Listing letter pack purchases failed"
    );
    throw new Error("Unable to list your orders right now. Please try again.");
  }

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "list.orders.success",
      count: orderSummaries.length,
      total: context.user.orders.length,
      packCount: packs.purchases.length,
      packTotal: packs.total
    },
    "Listed user orders"
  );

  return {
    orders: orderSummaries,
    total: context.user.orders.length,
    packPurchases: packs.purchases,
    packPurchaseTotal: packs.total
  };
}

export const listOrdersTool: McpToolDefinition<
  ListOrdersInput,
  ListOrdersOutput
> = {
  name: "list_orders",
  description:
    "List the user's recent orders: mailed letters and postcards (recipient and delivery status; use the order IDs with get_order_status) and letter pack purchases (payment status, letters in the pack, amount; use those order IDs with get_purchase_status). Use this when asked about a recent purchase, a pack, or whether a payment went through.",
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

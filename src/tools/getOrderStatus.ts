import {
  McpToolDefinition,
  ToolContext,
  OrderRecord
} from "../contracts/types.js";
import {
  getOrderStatusInputSchema,
  getOrderStatusOutputSchema
} from "../schemas.js";
import type { CertifiedMailService } from "../services/types.js";
import { certifiedOrderNote } from "./certifiedOrder.js";

interface GetOrderStatusInput {
  orderId?: string;
}

interface GetOrderStatusOutput {
  orderId: string;
  currentStatus: string;
  statusTimeline: { timestampISO: string; statusText: string }[];
  recipientSummary: { name: string; city: string; state: string };
  // Note: previewThumbnailHtml removed for performance (US-LETTER-04)
  // Preview was already shown at send time; status is for tracking delivery
  canSendFollowUp?: boolean;
  followUpSuggestedPrompt?: string;
  trackingSupport: "none" | "estimated_only" | "carrier_tracking";
  /** Sent with an arrival date (#535): its dates, and whether it can still be cancelled free. */
  arriveBy?: string;
  mailOn?: string;
  cancellable?: boolean;
  /** Sent as USPS Certified Mail (#625): the service, the carrier's number and its link once there is one, and what to say about them. */
  mailService?: CertifiedMailService;
  carrierTrackingNumber?: string;
  carrierTrackingUrl?: string;
  certifiedNote?: string;
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
      hasOrderId: Boolean(input.orderId),
      totalOrdersLoaded: context.user.orders.length
    },
    "Checking order status"
  );
  const order = selectOrder(context.user.orders, input.orderId);
  if (!order) {
    context.logger.warn(
      {
        correlationId: context.correlationId,
        event: "status.lookup.not_found",
        totalOrdersLoaded: context.user.orders.length
      },
      "No matching order found"
    );
    throw new Error("No matching order found for this user.");
  }

  // Note: previewThumbnailHtml removed for performance (US-LETTER-04, GitHub #83)
  // The preview was already shown at send time; status is for tracking delivery
  // Removing base64 image data reduces response payload significantly

  context.logger.info(
    {
      correlationId: context.correlationId,
      event: "status.lookup.success",
      currentStatus: order.currentStatus
    },
    "Resolved order status"
  );

  return {
    orderId: order.orderId,
    currentStatus: order.currentStatus,
    statusTimeline: order.statusTimeline,
    recipientSummary: order.recipientSummary,
    canSendFollowUp: true,
    followUpSuggestedPrompt: `Write a follow-up letter to ${order.recipientSummary.name}.`,
    // Carrier tracking only once USPS's number is stored, and not for a letter that did not go out (#625); until then, like any mail, estimated.
    trackingSupport:
      order.certified?.carrierTrackingNumber && order.currentStatus !== "failed" && order.currentStatus !== "cancelled"
        ? "carrier_tracking"
        : "estimated_only",
    ...(order.schedule
      ? { arriveBy: order.schedule.arriveBy, mailOn: order.schedule.mailOn, cancellable: order.cancellable === true }
      : {}),
    ...(order.certified
      ? {
          mailService: order.certified.mailService,
          ...(order.certified.carrierTrackingNumber
            ? { carrierTrackingNumber: order.certified.carrierTrackingNumber, carrierTrackingUrl: order.certified.carrierTrackingUrl }
            : {}),
          certifiedNote: certifiedOrderNote(order.certified, order.currentStatus)
        }
      : {})
  };
}

export const getOrderStatusTool: McpToolDefinition<
  GetOrderStatusInput,
  GetOrderStatusOutput
> = {
  name: "get_order_status",
  title: "Check an order's status",
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

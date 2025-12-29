import {
  LetterSnapshot,
  OrderRecord,
  OrderTimelineEntry,
  LetterStatus
} from "../contracts/types.js";

export interface OrderCreationParams {
  orderId: string;
  snapshot: LetterSnapshot;
  initialStatus?: LetterStatus;
  timestampISO: string;
}

const DEFAULT_INITIAL_STATUS: LetterStatus = "pending";

export function createOrderRecord({
  orderId,
  snapshot,
  initialStatus = DEFAULT_INITIAL_STATUS,
  timestampISO
}: OrderCreationParams): OrderRecord {
  const initialTimeline: OrderTimelineEntry = {
    timestampISO,
    statusText: initialStatus
  };

  return {
    orderId,
    snapshot,
    statusTimeline: [initialTimeline],
    currentStatus: initialStatus,
    creditsDeducted: snapshot.requiredCredits,
    recipientSummary: summarizeRecipient(snapshot),
    previewFirstPageHtml: undefined
  };
}

export function summarizeRecipient(snapshot: LetterSnapshot) {
  return {
    name: snapshot.recipient.name,
    city: snapshot.recipient.city,
    state: snapshot.recipient.state
  };
}

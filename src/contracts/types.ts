import type { ClientProfile } from "../auth/clientProfiles.js";

export type LetterStatus =
  | "pending"      // draft, queued
  | "accepted"     // PostGrid accepted order
  | "printing"     // Being printed
  | "in_transit"   // In the mail
  | "delivered"    // Delivered
  | "returned"     // Returned to sender
  | "failed"       // Failed
  | "cancelled";   // Cancelled

export type LetterLayoutType = "text_only" | "header_image" | "inline_image";

export interface Address {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export type Sender = Address;
export type Recipient = Address;

export interface LetterSnapshot {
  sender: Sender;
  recipient: Recipient;
  bodyText: string;
  signOff: string;
  requiredCredits: number;
}

export interface OrderTimelineEntry {
  timestampISO: string;
  statusText: string;
}

export interface OrderRecord {
  orderId: string;
  snapshot: LetterSnapshot;
  statusTimeline: OrderTimelineEntry[];
  currentStatus: LetterStatus;
  creditsDeducted: number;
  recipientSummary: {
    name: string;
    city: string;
    state: string;
  };
  previewFirstPageHtml?: string;
}

export interface UserAccount {
  userId: string;
  creditsRemaining: number;
  imageGenerationsRemaining?: number;
  orders: OrderRecord[];
}

export interface LogEvent {
  correlationId: string;
  [key: string]: unknown;
}

export interface Logger {
  info(event: LogEvent, message?: string): void;
  warn(event: LogEvent, message?: string): void;
  error(event: LogEvent, message?: string): void;
  debug?(event: LogEvent, message?: string): void;
  child(context: Record<string, unknown>): Logger;
}

export interface ToolContext {
  user: UserAccount;
  now(): Date;
  persist(account: UserAccount): Promise<void>;
  logger: Logger;
  correlationId: string;
  /**
   * True if request is from a mobile client (detected from userAgent).
   * Used for graceful degradation of features that don't work on mobile.
   * @see US-POSTCARD-04: Mobile Image Graceful Degradation
   */
  isMobile?: boolean;
  /**
   * The app the call came from (#473), for text that differs per app (#484).
   * Read it with callingApp(), which answers for a context without one.
   */
  client?: ClientProfile;
}

export interface ToolMeta {
  [key: string]: unknown;
}

export interface JsonSchema {
  [key: string]: unknown;
}

/**
 * What the model reads about a tool, every turn. A function gives each app its
 * own words where the same sentence would be false in some app (#484); read it
 * with describeTool() in src/server.ts.
 */
export type ToolDescription = string | ((client: ClientProfile) => string);

export interface McpToolDefinition<Input, Output> {
  name: string;
  /**
   * A short label: the name an app shows in its tool list and when it asks the
   * person to allow a call. Claude showed the whole description there while
   * tools had none (#484).
   */
  title: string;
  description: ToolDescription;
  readOnly: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  meta: ToolMeta;
  handler: (input: Input, context: ToolContext) => Promise<Output>;
}

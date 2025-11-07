export type LetterStatus = "queued_for_print" | "printing" | "mailed";

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
}

export interface ToolMeta {
  [key: string]: unknown;
}

export interface JsonSchema {
  [key: string]: unknown;
}

export interface McpToolDefinition<Input, Output> {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  meta: ToolMeta;
  handler: (input: Input, context: ToolContext) => Promise<Output>;
}

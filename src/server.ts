import "dotenv/config";
import { randomUUID } from "node:crypto";
import { FileAccountStore } from "./store/fileAccountStore.js";
import {
  // Letter tools - three separate tools for different layouts
  quoteAndPreviewLetterTextOnlyTool,
  quoteAndPreviewLetterWithHeaderImageTool,
  quoteAndPreviewLetterWithImageTool,
  sendLetterTool,
  createMailCheckoutTool,
  getPurchaseStatusTool,
  // Account and order management tools
  getOrderStatusTool,
  getAccountBalanceTool,
  listOrdersTool,
  setReturnAddressTool,
  getReturnAddressTool,
  clearReturnAddressTool,
  // Postcard tools
  quoteAndPreviewPostcardTool,
  sendPostcardTool,
  // Feedback tools
  submitFeatureRequestTool,
  getStartedTool,
  // Image upload tool
  uploadImageTool,
  // Image-intent router (returns routing guidance; does not generate)
  generateImageForMailTool,
  // Confirm uploaded image tool (widget relay)
  confirmUploadedImageTool
} from "./tools/index.js";
import {
  McpToolDefinition,
  ToolContext,
  UserAccount,
  Logger
} from "./contracts/types.js";
import { createLogger } from "./logging/index.js";
import { classifyDiagnosticError } from "./utils/diagnosticLog.js";

const tools: McpToolDefinition<any, any>[] = [
  // ChatGPT currently appears to expose only the first 12 registered actions
  // for this dev app. Keep core preview/send/status inside that first page of
  // tools; place auxiliary/internal tools later.
  // Letter tools - three separate tools for different layouts
  quoteAndPreviewLetterTextOnlyTool,
  quoteAndPreviewLetterWithHeaderImageTool,
  quoteAndPreviewLetterWithImageTool,
  sendLetterTool,
  createMailCheckoutTool,
  getPurchaseStatusTool,
  // Account and order management tools
  getOrderStatusTool,
  getAccountBalanceTool,
  listOrdersTool,
  // Postcard tools
  quoteAndPreviewPostcardTool,
  sendPostcardTool,
  // Image-intent router: must stay inside the exposed set so @-mention
  // generate requests land on it instead of a capability narration.
  generateImageForMailTool,
  // Keep saved return address setup in the primary exposed set.
  setReturnAddressTool,
  getReturnAddressTool,
  // Auxiliary tools after the likely ChatGPT exposed-action cutoff.
  clearReturnAddressTool,
  // Feedback tools
  submitFeatureRequestTool,
  getStartedTool,
  // Image upload tool
  uploadImageTool,
  // Confirm uploaded image tool (widget relay)
  confirmUploadedImageTool
];

export interface ServerRequest<Input> {
  toolName: string;
  input: Input;
  userId: string;
  /**
   * True if request is from a mobile client (detected from userAgent).
   * @see US-POSTCARD-04: Mobile Image Graceful Degradation
   */
  isMobile?: boolean;
}

export interface ServerResponse<Output> {
  result: Output;
  meta: Record<string, unknown>;
}

export function summarizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return { type: typeof input };
  }
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 8);
  return {
    fieldCount: Object.keys(input as Record<string, unknown>).length,
    fields: entries.map(([name, value]) => ({
      name,
      type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value
    }))
  };
}

export class LetterIrlServer {
  private store = new FileAccountStore();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly logger: Logger = createLogger({
      context: { service: "letter-irl" }
    })
  ) {}

  private async createContext(
    userId: string,
    logger: Logger,
    correlationId: string,
    isMobile?: boolean
  ): Promise<ToolContext> {
    const account = await this.store.getOrCreate(userId);
    return {
      user: account,
      now: this.now,
      persist: async (updated: UserAccount) => {
        await this.store.persist(updated);
      },
      logger,
      correlationId,
      isMobile
    };
  }

  async execute<Input, Output>(
    request: ServerRequest<Input>
  ): Promise<ServerResponse<Output>> {
    const tool = tools.find((candidate) => candidate.name === request.toolName);
    if (!tool) {
      throw new Error(`Tool ${request.toolName} is not registered.`);
    }

    const correlationId = randomUUID();
    const requestLogger = this.logger.child({
      correlationId,
      toolName: request.toolName
    });

    requestLogger.info(
      {
        correlationId,
        event: "tool.invocation.start",
        inputSummary: summarizeToolInput(request.input)
      },
      "Tool invocation started"
    );

    const context = await this.createContext(
      request.userId,
      requestLogger.child({ stage: "tool-handler" }),
      correlationId,
      request.isMobile
    );

    try {
      const result = await tool.handler(request.input as Input, context);

      requestLogger.info(
        {
          correlationId,
          event: "tool.invocation.success",
          readOnly: tool.readOnly
        },
        "Tool invocation succeeded"
      );

      return {
        result: result as Output,
        meta: tool.meta
      };
    } catch (error) {
      // Prefer a class the failing layer already resolved (the same pattern as
      // dashboardApiHandler and runMaintenance): tool-layer wrappers rebuild
      // errors, and a rebuilt Error has neither .code nor .type, so without
      // this the log recorded literally unknown_error for a fault the
      // commerce layer had classified precisely (#278 review round 4).
      const carried =
        error && typeof error === "object" && "diagnosticClass" in error &&
        typeof (error as { diagnosticClass?: unknown }).diagnosticClass === "string"
          ? (error as { diagnosticClass: string }).diagnosticClass
          : undefined;
      requestLogger.error(
        {
          correlationId,
          event: "tool.invocation.failure",
          errorClass: carried ?? classifyDiagnosticError(error, "unknown_error")
        },
        "Tool invocation failed"
      );
      throw error;
    }
  }

  listTools() {
    return tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      readOnly: tool.readOnly,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      meta: tool.meta
    }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new LetterIrlServer();
  console.log("Registered tools:");
  console.table(server.listTools().map(({ name, readOnly }) => ({ name, readOnly })));
}

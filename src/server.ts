import "dotenv/config";
import { randomUUID } from "node:crypto";
import { assertBetaAccess } from "./auth/betaAccess.js";
import { FileAccountStore } from "./store/fileAccountStore.js";
import {
  // Letter tools - three separate tools for different layouts
  quoteAndPreviewLetterTextOnlyTool,
  quoteAndPreviewLetterWithHeaderImageTool,
  quoteAndPreviewLetterWithImageTool,
  sendLetterTool,
  createMailCheckoutTool,
  createPackCheckoutTool,
  listLetterPacksTool,
  redeemPromoCodeTool,
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
  getProfileTool,
  getStartedTool,
  // Image upload tool
  uploadImageTool,
  // Image-intent router (returns routing guidance; does not generate)
  generateImageForMailTool,
  // Confirm uploaded image tool (widget relay)
  confirmUploadedImageTool,
  // A link where the person sends a preview themselves (#470)
  requestSendTool
} from "./tools/index.js";
import { REQUEST_SEND_TOOL } from "./tools/requestSend.js";
import { isSendConfirmationEnabled } from "./config/sendConfirmation.js";
import {
  McpToolDefinition,
  ToolContext,
  ToolDescription,
  UserAccount,
  Logger
} from "./contracts/types.js";
import { callingApp, type ClientProfile } from "./auth/clientProfiles.js";
import { createLogger } from "./logging/index.js";
import { carriedDiagnosticClass, classifyDiagnosticError } from "./utils/diagnosticLog.js";

const tools: McpToolDefinition<any, any>[] = [
  // An early observation was that ChatGPT exposed only the first 12
  // registered actions. It ingests the whole list now - the #160 learning
  // shows the 18th tool on the connector page with its security schemes, and
  // get_profile is found by its _meta marker wherever it sits - but the order
  // still reads as priority, so core preview/send/status stay first and
  // auxiliary tools follow.
  // Letter tools - three separate tools for different layouts
  quoteAndPreviewLetterTextOnlyTool,
  quoteAndPreviewLetterWithHeaderImageTool,
  quoteAndPreviewLetterWithImageTool,
  sendLetterTool,
  createMailCheckoutTool,
  createPackCheckoutTool,
  listLetterPacksTool,
  redeemPromoCodeTool,
  getPurchaseStatusTool,
  // Account and order management tools
  getOrderStatusTool,
  getAccountBalanceTool,
  listOrdersTool,
  // Postcard tools
  quoteAndPreviewPostcardTool,
  sendPostcardTool,
  // The model's way to send, once the send rule is on (#470): a link where
  // the person sends the preview themselves. Listed only while the rule is on.
  requestSendTool,
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
  getProfileTool,
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
  /** The app the call came from (#473), for text that differs per app (#484). */
  client?: ClientProfile;
}

export interface ServerResponse<Output> {
  result: Output;
  meta: Record<string, unknown>;
}

/**
 * The checkouts: listed only where the app takes purchases (#475). Claude
 * allows no purchases through connectors, and the Connectors Directory takes
 * no connector that executes financial transactions. There, letters are
 * bought on the website, which get_started, get_account_balance and
 * list_letter_packs link to.
 */
export const IN_APP_PURCHASE_TOOLS: ReadonlySet<string> = new Set([
  "create_pack_checkout",
  "create_mail_checkout"
]);

/**
 * A tool's description as the calling app reads it (#484). Most tools say the
 * same to every app; a few give each app its own words.
 */
export function describeTool(tool: { description: ToolDescription }, client: ClientProfile): string {
  return typeof tool.description === "function" ? tool.description(client) : tool.description;
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
    isMobile?: boolean,
    client?: ClientProfile
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
      isMobile,
      client
    };
  }

  async execute<Input, Output>(
    request: ServerRequest<Input>
  ): Promise<ServerResponse<Output>> {
    // The tool layer's own gate. validateAuthorizationHeader covers every HTTP
    // request, but this path is also reached by the stdio transport and by
    // LETTER_IRL_REQUIRE_AUTH=false, where no validator runs at all. Local
    // development authenticates as "mcp-user", which is on no invite list -
    // hence LETTER_IRL_BETA_GATE_ENABLED=false in every .env*.example.
    assertBetaAccess(request.userId);

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
      request.isMobile,
      request.client
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
      const carried = carriedDiagnosticClass(error);
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

  /**
   * The tools as one app sees them: each description in that app's words
   * (#484), and the checkouts only where it takes purchases (#475). Without an
   * app, the list for an app that trusts nothing.
   */
  listTools(client: ClientProfile = callingApp(undefined)) {
    // request_send points at the confirmation page, which ships with the send
    // rule, so the tool is listed only while the rule is on. execute() still
    // reaches it: a send tool answers an app without our card with its link
    // (src/mcp/registerTools.ts).
    const sendRule = isSendConfirmationEnabled();
    return tools
      .filter((tool) => sendRule || tool.name !== REQUEST_SEND_TOOL)
      .filter((tool) => client.inAppPurchases || !IN_APP_PURCHASE_TOOLS.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: describeTool(tool, client),
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

import { randomUUID, createHash } from "node:crypto";
import { FileAccountStore } from "./store/fileAccountStore.js";
import {
  quoteAndPreviewLetterTool,
  sendLetterTool,
  getOrderStatusTool,
  getAccountBalanceTool
} from "./tools/index.js";
import {
  McpToolDefinition,
  ToolContext,
  UserAccount,
  Logger
} from "./contracts/types.js";
import { createLogger } from "./logging/index.js";

const tools: McpToolDefinition<unknown, unknown>[] = [
  quoteAndPreviewLetterTool,
  sendLetterTool,
  getOrderStatusTool,
  getAccountBalanceTool
];

export interface ServerRequest<Input> {
  toolName: string;
  input: Input;
  userId: string;
}

export interface ServerResponse<Output> {
  result: Output;
  meta: Record<string, unknown>;
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
    correlationId: string
  ): Promise<ToolContext> {
    const account = await this.store.getOrCreate(userId);
    return {
      user: account,
      now: this.now,
      persist: async (updated: UserAccount) => {
        await this.store.persist(updated);
      },
      logger,
      correlationId
    };
  }

  private obfuscateUserId(userId: string): string {
    return createHash("sha256").update(userId).digest("hex").slice(0, 12);
  }

  private summarizeInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object") {
      return { type: typeof input };
    }
    const entries = Object.entries(input as Record<string, unknown>)
      .slice(0, 8)
      .map(([key, value]) => {
        if (typeof value === "object" && value !== null) {
          return [key, "[object]"];
        }
        return [key, value];
      });
    return Object.fromEntries(entries);
  }

  async execute<Input, Output>(
    request: ServerRequest<Input>
  ): Promise<ServerResponse<Output>> {
    const tool = tools.find((candidate) => candidate.name === request.toolName);
    if (!tool) {
      throw new Error(`Tool ${request.toolName} is not registered.`);
    }

    const correlationId = randomUUID();
    const userHash = this.obfuscateUserId(request.userId);
    const requestLogger = this.logger.child({
      correlationId,
      toolName: request.toolName,
      userHash
    });

    requestLogger.info(
      {
        correlationId,
        event: "tool.invocation.start",
        inputSummary: this.summarizeInput(request.input)
      },
      "Tool invocation started"
    );

    const context = await this.createContext(
      request.userId,
      requestLogger.child({ stage: "tool-handler" }),
      correlationId
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
      requestLogger.error(
        {
          correlationId,
          event: "tool.invocation.failure",
          errorMessage: error instanceof Error ? error.message : "Unknown error"
        },
        "Tool invocation failed"
      );
      throw error;
    }
  }

  listTools() {
    return tools.map((tool) => ({
      name: tool.name,
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

import { kickPriceCatalog } from "../services/priceCatalog.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LetterIrlServer } from "../server.js";
import {
  classifyDiagnosticError,
  writeDiagnostic
} from "../utils/diagnosticLog.js";
import { registerLetterTools } from "./registerTools.js";

export async function startStdioServer() {
  const appServer = new LetterIrlServer();
  const mcpServer = new McpServer({
    name: "letter-irl",
    version: "0.1.0"
  });

  registerLetterTools(mcpServer, appServer);

  // The stdio lane had NO price warmup, so the first quote's eligibility was
  // a guaranteed miss - "temporarily unavailable" on a healthy deployment,
  // every session (#278 round 6). Same fire-and-forget policy as the HTTP
  // listen callback; connect() is not held up.
  kickPriceCatalog(undefined, 'stdio_startup');

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStdioServer().catch((error) => {
    writeDiagnostic("error", "mcp.stdio_start_failed", {
      errorClass: classifyDiagnosticError(error, "configuration_error")
    });
    process.exit(1);
  });
}

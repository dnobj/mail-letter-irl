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

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStdioServer().catch((error) => {
    writeDiagnostic("error", "mcp.stdio_start_failed", {
      errorClass: classifyDiagnosticError(error, "server_lifecycle_failed")
    });
    process.exit(1);
  });
}

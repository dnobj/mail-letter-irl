import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LetterIrlServer } from "../server.js";
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
    console.error("Failed to start Letter IRL MCP server", error);
    process.exit(1);
  });
}

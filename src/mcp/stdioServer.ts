import { kickPriceCatalog } from "../services/priceCatalog.js";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LetterIrlServer } from "../server.js";
import {
  classifyDiagnosticError,
  writeDiagnostic
} from "../utils/diagnosticLog.js";
import { registerLetterTools } from "./registerTools.js";
import { buildServerInstructions } from "./serverInstructions.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";
import { resolveClientProfile } from "../auth/clientProfiles.js";

export async function startStdioServer() {
  const appServer = new LetterIrlServer();
  // One server per connection, for either protocol revision (#477): SDK v2's serveStdio asks the factory again for
  // a 2026-07-28 client's discover probe. Registration is awaited now; it was not, so a call could beat the tools.
  const build = async () => {
    const mcpServer = new McpServer(
      { name: "letter-irl", version: "0.1.0" },
      { instructions: buildServerInstructions(isSendConfirmationEnabled(), resolveClientProfile(null)) }
    );
    await registerLetterTools(mcpServer, appServer);
    return mcpServer;
  };

  // The stdio lane had NO price warmup, so the first quote's eligibility was
  // a guaranteed miss - "temporarily unavailable" on a healthy deployment,
  // every session (#278 round 6). Same fire-and-forget policy as the HTTP
  // listen callback; connect() is not held up.
  kickPriceCatalog(undefined, 'stdio_startup');

  serveStdio(build, {
    // A server that cannot be built is answered "Internal server error" by the SDK; say why here too.
    onerror: (error) => {
      writeDiagnostic("error", "mcp.stdio_error", { errorClass: classifyDiagnosticError(error, "configuration_error") });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startStdioServer().catch((error) => {
    writeDiagnostic("error", "mcp.stdio_start_failed", {
      errorClass: classifyDiagnosticError(error, "configuration_error")
    });
    process.exit(1);
  });
}

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LetterIrlServer } from "../server.js";
import { registerLetterTools } from "./registerTools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WIDGET_DIR = path.resolve(__dirname, "..", "..", "widgets");
const DEFAULT_HOST = process.env.LETTER_IRL_HTTP_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.LETTER_IRL_HTTP_PORT ?? "8090");
const MCP_PATH = process.env.LETTER_IRL_MCP_PATH ?? "/mcp";
const WIDGET_PATH = process.env.LETTER_IRL_WIDGET_PATH ?? "/widgets";
const MANIFEST_ROUTE = process.env.LETTER_IRL_MANIFEST_ROUTE ?? "/manifest.json";
const MANIFEST_FILE_PATH =
  process.env.LETTER_IRL_MANIFEST_FILE ??
  path.resolve(__dirname, "..", "..", "manifest.json");
const FALLBACK_ORIGIN =
  process.env.LETTER_IRL_DEFAULT_ORIGIN ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

function getAllowedHosts(): string[] {
  const raw = process.env.LETTER_IRL_ALLOWED_HOSTS;
  if (!raw) {
    return [
      `${DEFAULT_HOST}:${DEFAULT_PORT}`,
      DEFAULT_HOST,
      "localhost",
      "localhost:8090"
    ];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getAllowedOrigins(): string[] {
  const raw = process.env.LETTER_IRL_ALLOWED_ORIGINS;
  if (!raw) {
    return [
      "https://chatgpt.com",
      "https://chat.openai.com",
      "http://localhost:4173",
      `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
      "http://127.0.0.1:8090",
      "http://localhost:8090"
    ];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function serveWidget(
  widgetName: string,
  res: http.ServerResponse
): Promise<boolean> {
  const safeName = path.basename(widgetName);
  const filePath = path.join(DEFAULT_WIDGET_DIR, safeName);
  try {
    const file = await fs.readFile(filePath, "utf-8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    res.statusCode = 500;
    res.end("Internal Server Error");
    return true;
  }
}

export async function startHttpServer() {
  const letterServer = new LetterIrlServer();
  const mcpServer = new McpServer({
    name: "letter-irl",
    version: "0.1.0"
  });

  registerLetterTools(mcpServer, letterServer);

  const transport = new StreamableHTTPServerTransport({
    endpointPath: MCP_PATH,
    allowedHosts: getAllowedHosts(),
    allowedOrigins: getAllowedOrigins(),
    enableDnsRebindingProtection: true,
    enableJsonResponse: true
  });

  await mcpServer.connect(transport);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);

    if (url.pathname === "/healthz") {
      res.statusCode = 200;
      res.end("ok");
      return;
    }

    if (url.pathname === MANIFEST_ROUTE) {
      try {
        const file = await fs.readFile(MANIFEST_FILE_PATH, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        res.statusCode = code === "ENOENT" ? 404 : 500;
        res.end(code === "ENOENT" ? "Manifest not found" : "Manifest read error");
      }
      return;
    }

    if (url.pathname.startsWith(WIDGET_PATH)) {
      const widgetName = url.pathname.replace(`${WIDGET_PATH}/`, "");
      if (!widgetName) {
        res.statusCode = 404;
        res.end("Widget not specified");
        return;
      }
      const served = await serveWidget(widgetName, res);
      if (!served) {
        res.statusCode = 404;
        res.end("Widget not found");
      }
      return;
    }

    if (url.pathname === MCP_PATH) {
      if (!req.headers.origin) {
        req.headers.origin = FALLBACK_ORIGIN;
      }

      console.log(
        `MCP request ${new Date().toISOString()} method=${req.method} host=${req.headers.host} origin=${req.headers.origin}`
      );

      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("MCP request failed", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      }
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
      console.log(`Letter IRL MCP HTTP server listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
      console.log(`  MCP endpoint: http://${DEFAULT_HOST}:${DEFAULT_PORT}${MCP_PATH}`);
      console.log(`  Widget assets: http://${DEFAULT_HOST}:${DEFAULT_PORT}${WIDGET_PATH}/<name>.html`);
      resolve();
    });
  });

  const close = () => {
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startHttpServer().catch((error) => {
    console.error("Failed to start HTTP MCP server", error);
    process.exit(1);
  });
}

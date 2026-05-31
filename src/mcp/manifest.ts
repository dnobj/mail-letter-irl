import { LetterIrlServer } from "../server.js";
import { WIDGET_DEFINITIONS } from "./registerTools.js";
import { LETTER_IRL_SERVER_INSTRUCTIONS } from "./serverInstructions.js";

const DEFAULT_PUBLIC_BASE_URL =
  process.env.LETTER_IRL_PUBLIC_BASE_URL ?? "https://api.letterirl.com";
const DEFAULT_MCP_PATH = process.env.LETTER_IRL_MCP_PATH ?? "/mcp";
const DEFAULT_HEALTH_PATH = process.env.LETTER_IRL_HEALTH_PATH ?? "/healthz";
const DEFAULT_AUTH_SERVER_ROUTE =
  process.env.LETTER_IRL_AUTH_SERVER_ROUTE ?? "/.well-known/oauth-authorization-server";

export const APP_DIRECTORY_DESCRIPTION =
  "Draft, preview, and mail real physical letters and postcards through USPS from ChatGPT. " +
  "To send mail, first buy pre-paid letter sends on letterirl.com.";

export function buildManifest() {
  const server = new LetterIrlServer();
  const tools = server.listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema
  }));

  return {
    name: "Letter IRL",
    version: "0.1.0",
    description: APP_DIRECTORY_DESCRIPTION,
    instructions: LETTER_IRL_SERVER_INSTRUCTIONS,
    contactEmail: "support@letterirl.com",
    legalInfoUrl: "https://letterirl.com/terms",
    tools,
    ui: {
      widgets: WIDGET_DEFINITIONS.map((widget) => widget.name)
    },
    servers: [
      {
        type: "mcp",
        name: "letter-irl",
        url: `${DEFAULT_PUBLIC_BASE_URL}${DEFAULT_MCP_PATH}`,
        healthUrl: `${DEFAULT_PUBLIC_BASE_URL}${DEFAULT_HEALTH_PATH}`,
        transport: {
          type: "streamableHttp"
        },
        auth: {
          type: "oauth",
          scopes: ["openid", "email", "profile"],
          authorizationServer: `${DEFAULT_PUBLIC_BASE_URL}${DEFAULT_AUTH_SERVER_ROUTE}`
        }
      }
    ],
    compatibilityNotes: {
      sourceOfTruth: "Runtime MCP tool registry",
      generated: true
    }
  };
}

export function stringifyManifest(): string {
  return `${JSON.stringify(buildManifest(), null, 2)}\n`;
}

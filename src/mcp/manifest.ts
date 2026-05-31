import { LetterIrlServer } from "../server.js";
import { WIDGET_DEFINITIONS } from "./registerTools.js";
import { LETTER_IRL_SERVER_INSTRUCTIONS } from "./serverInstructions.js";

function getManifestUrls(publicBaseUrlOverride?: string) {
  const publicBaseUrl =
    publicBaseUrlOverride ?? process.env.LETTER_IRL_PUBLIC_BASE_URL ?? "https://api.letterirl.com";
  const mcpPath = process.env.LETTER_IRL_MCP_PATH ?? "/mcp";
  const healthPath = process.env.LETTER_IRL_HEALTH_PATH ?? "/healthz";
  const authServerRoute =
    process.env.LETTER_IRL_AUTH_SERVER_ROUTE ?? "/.well-known/oauth-authorization-server";

  return {
    authServerUrl: `${publicBaseUrl}${authServerRoute}`,
    healthUrl: `${publicBaseUrl}${healthPath}`,
    mcpUrl: `${publicBaseUrl}${mcpPath}`
  };
}

export const APP_DIRECTORY_DESCRIPTION =
  "Draft, preview, and mail real physical letters and postcards through USPS from ChatGPT. " +
  "To send mail, first buy pre-paid letter sends on letterirl.com.";

export function buildManifest(publicBaseUrl?: string) {
  const server = new LetterIrlServer();
  const urls = getManifestUrls(publicBaseUrl);
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
        url: urls.mcpUrl,
        healthUrl: urls.healthUrl,
        transport: {
          type: "streamableHttp"
        },
        auth: {
          type: "oauth",
          scopes: ["openid", "email", "profile"],
          authorizationServer: urls.authServerUrl
        }
      }
    ],
    compatibilityNotes: {
      sourceOfTruth: "Runtime MCP tool registry",
      generated: true
    }
  };
}

export function stringifyManifest(publicBaseUrl?: string): string {
  return `${JSON.stringify(buildManifest(publicBaseUrl), null, 2)}\n`;
}

import { LetterIrlServer } from "../server.js";
import { WIDGET_DEFINITIONS } from "./registerTools.js";
import { DEFAULT_OAUTH_SCOPES } from "../auth/oauthConfig.js";
import { LETTER_IRL_SERVER_INSTRUCTIONS } from "./serverInstructions.js";

function getManifestUrls(publicBaseUrlOverride?: string) {
  const publicBaseUrl =
    publicBaseUrlOverride ?? process.env.LETTER_IRL_PUBLIC_BASE_URL ?? "https://api.letterirl.com";
  const mcpPath = process.env.LETTER_IRL_MCP_PATH ?? "/mcp";
  const healthPath = process.env.LETTER_IRL_HEALTH_PATH ?? "/healthz";
  const authorizationServer =
    process.env.LETTER_IRL_OAUTH_ISSUER ??
    "https://dev-njmdyqf8n25rqgy7.us.auth0.com/";

  return {
    authorizationServer,
    healthUrl: `${publicBaseUrl}${healthPath}`,
    mcpUrl: `${publicBaseUrl}${mcpPath}`
  };
}

// The connector card in the directory, and the first prose the model reads
// about this app. #313 removed "buy on letterirl.com" from every tool
// description and left this one behind, because modelFacingCopy.test.ts
// iterates listTools() and the manifest's own prose is not a tool. It reached
// production that way and was found while connecting the production connector.
export const APP_DIRECTORY_DESCRIPTION =
  "Draft, preview, and mail real physical letters and postcards through USPS from ChatGPT. " +
  "Buy prepaid letters without leaving the conversation, or pay for a single letter as you send it.";

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
          scopes: DEFAULT_OAUTH_SCOPES,
          authorizationServer: urls.authorizationServer
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

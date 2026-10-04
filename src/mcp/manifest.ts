import { LetterIrlServer } from "../server.js";
import { servesPostcardSixByNineOnly, listedWidgets, withheldInputKeys } from "./registerTools.js";
import { postcardSixByNineProperties } from "../schemas.js";
import { DEFAULT_OAUTH_SCOPES } from "../auth/oauthConfig.js";
import { buildServerInstructions } from "./serverInstructions.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";
import { clientProfileNamed } from "../auth/clientProfiles.js";

/**
 * A tool's input schema as tools/list serves it, without the fields this
 * deployment withholds (withheldInputKeys): the four previews' `arriveBy`
 * (#535) while LETTER_IRL_ARRIVE_BY_ENABLED is off, and the three letter
 * previews' stationery (#563) while it is not offered. set_arrival_date is
 * listed only while arrive-by is on, its own arriveBy with it. The postcard
 * preview's `message` and `size` are served as before the 4x6 and 11x6
 * (#594) while those are not offered (servesPostcardSixByNineOnly).
 */
function servedInputSchema(name: string, schema: unknown): unknown {
  const declared = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!declared) return schema;
  const properties = servesPostcardSixByNineOnly(name) ? { ...declared, ...postcardSixByNineProperties } : declared;
  const withheld = withheldInputKeys(name);
  if (properties === declared && withheld.length === 0) return schema;
  const served = Object.fromEntries(Object.entries(properties).filter(([key]) => !withheld.includes(key)));
  return { ...(schema as object), properties: served };
}

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
  // ChatGPT's manifest, so ChatGPT's words where tools and instructions give
  // each app its own (#484).
  const chatgpt = clientProfileNamed("chatgpt");
  const tools = server.listTools(chatgpt).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: servedInputSchema(tool.name, tool.inputSchema),
    outputSchema: tool.outputSchema
  }));

  return {
    name: "Letter IRL",
    version: "0.1.0",
    description: APP_DIRECTORY_DESCRIPTION,
    instructions: buildServerInstructions(isSendConfirmationEnabled(), chatgpt),
    contactEmail: "support@letterirl.com",
    legalInfoUrl: "https://letterirl.com/terms",
    tools,
    ui: {
      widgets: listedWidgets().map((widget) => widget.name)
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

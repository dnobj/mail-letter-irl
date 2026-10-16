import { LetterIrlServer } from "../server.js";
import { getServedInputSchema, getZodOutputShape, listedWidgets } from "./registerTools.js";
import { normalizeObjectSchema, objectFromShape } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { DEFAULT_OAUTH_SCOPES } from "../auth/oauthConfig.js";
import { buildServerInstructions } from "./serverInstructions.js";
import { isSendConfirmationEnabled } from "../config/sendConfirmation.js";
import { clientProfileNamed } from "../auth/clientProfiles.js";

/**
 * A tool's schemas exactly as tools/list serves them (#688): the served Zod shapes (getServedInputSchema, with the
 * fields this deployment withholds left out and the postcard and set_stationery served as before their features),
 * converted by the SDK's own converter with the options its tools/list handler uses. So the manifest and tools/list
 * cannot disagree, and src/zodSchemas.ts is the one tool contract.
 */
function servedJsonSchema(schema: unknown, pipeStrategy: "input" | "output"): unknown {
  // As registerTool stores it: a raw shape, even an empty one, becomes an object schema first.
  const isRawShape = typeof schema === "object" && schema !== null && !("_def" in schema) && !("_zod" in schema);
  const stored = isRawShape ? objectFromShape(schema as Parameters<typeof objectFromShape>[0]) : schema;
  const object = normalizeObjectSchema(stored as Parameters<typeof normalizeObjectSchema>[0]);
  return object ? toJsonSchemaCompat(object, { strictUnions: true, pipeStrategy }) : { type: "object", properties: {} };
}

/** A tool's input and output schemas as tools/list and /manifest.json serve them, as this deployment stands. */
export function servedToolJsonSchemas(name: string): { inputSchema: any; outputSchema: any } {
  return {
    inputSchema: servedJsonSchema(getServedInputSchema(name), "input"),
    outputSchema: servedJsonSchema(getZodOutputShape(name), "output")
  };
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
    ...servedToolJsonSchemas(tool.name)
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

import { AuthenticatedUser, requireScopes } from "./tokenValidator.js";

export type ProductScope = "mail:read" | "mail:draft" | "mail:send";

const TOOL_SCOPES: Record<string, ProductScope> = {
  get_started: "mail:read",
  generate_image_for_mail: "mail:read",
  get_account_balance: "mail:read",
  get_purchase_status: "mail:read",
  get_order_status: "mail:read",
  list_orders: "mail:read",
  get_return_address: "mail:read",
  quote_and_preview_letter: "mail:draft",
  quote_and_preview_letter_with_header_image: "mail:draft",
  quote_and_preview_letter_with_image: "mail:draft",
  quote_and_preview_postcard: "mail:draft",
  set_return_address: "mail:draft",
  clear_return_address: "mail:draft",
  upload_image: "mail:draft",
  confirm_uploaded_image: "mail:draft",
  submit_feature_request: "mail:draft",
  create_mail_checkout: "mail:send",
  send_letter: "mail:send",
  send_postcard: "mail:send"
};

export function getRequiredToolScopes(toolName: string): ProductScope[] {
  const scope = TOOL_SCOPES[toolName];
  if (!scope) {
    throw new Error(`No OAuth scope mapping exists for tool ${toolName}`);
  }
  return [scope];
}

export function authorizeTool(
  toolName: string,
  authInfo: AuthenticatedUser | null,
  requireAuth = process.env.LETTER_IRL_REQUIRE_AUTH !== "false"
): void {
  if (!requireAuth) {
    return;
  }
  if (!authInfo) {
    throw new Error("Authentication required");
  }
  requireScopes(authInfo, getRequiredToolScopes(toolName));
}

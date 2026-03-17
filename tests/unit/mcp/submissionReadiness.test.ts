import { describe, expect, it } from "vitest";
import { getOpenIdConfiguration } from "../../../src/auth/metadata.js";
import { buildManifest, APP_DIRECTORY_DESCRIPTION } from "../../../src/mcp/manifest.js";
import {
  WIDGET_DEFINITIONS,
  WIDGET_MIME_TYPE,
  buildToolMeta,
  buildToolSecuritySchemes
} from "../../../src/mcp/registerTools.js";

describe("Submission readiness checks", () => {
  it("should advertise the current app description with purchase prerequisite", () => {
    expect(APP_DIRECTORY_DESCRIPTION).toContain("real physical letters and postcards");
    expect(APP_DIRECTORY_DESCRIPTION).toContain("pre-paid letter sends on letterirl.com");
  });

  it("should expose the full widget inventory in the compatibility manifest", () => {
    expect(buildManifest().ui.widgets).toEqual(
      WIDGET_DEFINITIONS.map((widget) => widget.name)
    );
  });

  it("should register the current widget MIME profile", () => {
    expect(WIDGET_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });

  it("should include OAuth security schemes when auth is required", () => {
    expect(buildToolSecuritySchemes(true)).toEqual([
      {
        type: "oauth2",
        scopes: ["openid", "email", "profile"]
      }
    ]);
  });

  it("should expose noauth security schemes when auth is disabled", () => {
    expect(buildToolSecuritySchemes(false)).toEqual([{ type: "noauth" }]);
  });

  it("should copy securitySchemes into tool metadata", () => {
    const meta = buildToolMeta({ "openai/widgetAccessible": true }, true);
    expect(meta.securitySchemes).toEqual([
      {
        type: "oauth2",
        scopes: ["openid", "email", "profile"]
      }
    ]);
    expect(meta["openai/widgetAccessible"]).toBe(true);
  });

  it("should advertise CMID support in OIDC metadata", () => {
    const metadata = getOpenIdConfiguration("https://api.letterirl.com");
    expect(metadata.client_id_metadata_document_supported).toBe(true);
  });
});

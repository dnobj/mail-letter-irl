import { describe, expect, it, vi } from "vitest";

// The first test in this file pays for importing a whole server module graph
// (every tool, the commerce and Stripe code, the database client, the auth
// stack). On a cold transform cache or a busy disk that import alone took
// about 12 s on 2026-09-13, over vitest's 10 s default, while CI does it in a
// few seconds. Raised from 30 s to 60 s later the same day: under a full
// parallel run on a loaded workstation three of these files still timed out
// while each passed alone. The limit is per test and says nothing about how
// fast the app boots; nothing here measures boot time.
vi.setConfig({ testTimeout: 60_000 });

import { widgetTemplateUri } from "../../../src/mcp/widgetUris.js";
import { getOpenIdConfiguration } from "../../../src/auth/metadata.js";
import {
  buildWwwAuthenticateChallenge,
  getPublicBaseUrl
} from "../../../src/mcp/httpServer.js";
import { buildManifest, APP_DIRECTORY_DESCRIPTION } from "../../../src/mcp/manifest.js";
import {
  buildWidgetResourceMeta,
  WIDGET_DEFINITIONS,
  WIDGET_MIME_TYPE,
  buildToolMeta,
  buildToolSecuritySchemes
} from "../../../src/mcp/registerTools.js";

describe("Submission readiness checks", () => {
  it("should advertise what the app does, without a stale purchase route", () => {
    // This assertion used to REQUIRE "pre-paid letter sends on letterirl.com".
    // The description was therefore not unguarded when #311/#312 moved buying
    // into the conversation and #313 cleaned every tool description - it was
    // guarded in the wrong direction, pinning the stale sentence in place and
    // failing the moment it was corrected. A test that demands specific
    // marketing copy outlives whatever made the copy true; this one asserts
    // the durable claim and the absence of the route that went stale.
    expect(APP_DIRECTORY_DESCRIPTION).toContain("real physical letters and postcards");
    expect(APP_DIRECTORY_DESCRIPTION).not.toMatch(/letterirl\.com/i);
    expect(APP_DIRECTORY_DESCRIPTION).not.toMatch(/credit/i);
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
    expect(buildToolSecuritySchemes("send_letter", true)).toEqual([
      {
        type: "oauth2",
        // offline_access and the identity scopes are requested here, never
        // enforced. ChatGPT unions these per-tool lists for offline_access
        // (#160); it did not for the identity scopes (#424), which stay for
        // clients that honour the tags.
        scopes: ["mail:send", "offline_access", "openid", "email"]
      }
    ]);
  });

  it("should expose noauth security schemes when auth is disabled", () => {
    expect(buildToolSecuritySchemes("send_letter", false)).toEqual([{ type: "noauth" }]);
  });

  it("should copy securitySchemes into tool metadata", () => {
    const meta = buildToolMeta(
      "quote_and_preview_letter",
      {
        "openai/outputTemplate": widgetTemplateUri("LetterPreviewCard"),
        "openai/widgetAccessible": true
      },
      true
    );
    expect(meta.securitySchemes).toEqual([
      {
        type: "oauth2",
        scopes: ["mail:draft", "offline_access", "openid", "email"]
      }
    ]);
    expect(meta["openai/widgetAccessible"]).toBe(true);
    expect(meta.ui).toMatchObject({
      resourceUri: widgetTemplateUri("LetterPreviewCard"),
      widgetAccessible: true
    });
  });

  it("should expose canonical ui metadata for widget resources", () => {
    const meta = buildWidgetResourceMeta("Test widget");
    expect(meta.ui).toMatchObject({
      description: "Test widget",
      domain: "https://api.letterirl.com",
      prefersBorder: true
    });
    expect(meta).toMatchObject({
      "openai/widgetPrefersBorder": true,
      "openai/widgetDescription": "Test widget"
    });
  });

  it("should not synthesize Auth0 CIMD support", () => {
    const metadata = getOpenIdConfiguration("https://api.letterirl.com") as Record<
      string,
      unknown
    >;
    expect(metadata).not.toHaveProperty("client_id_metadata_document_supported");
  });

  it("should derive public metadata URLs from the forwarded custom domain", () => {
    const publicBaseUrl = getPublicBaseUrl({
      headers: {
        "x-forwarded-host": "api.letterirl.com",
        "x-forwarded-proto": "https",
        host: "letter-irl-api-production.up.railway.app"
      }
    });

    expect(publicBaseUrl).toBe("https://api.letterirl.com");
    expect(buildManifest(publicBaseUrl).servers[0].url).toBe("https://api.letterirl.com/mcp");
    expect(buildWwwAuthenticateChallenge("Missing Authorization header", publicBaseUrl)).toContain(
      'resource_metadata="https://api.letterirl.com/.well-known/oauth-protected-resource"'
    );
  });

  it("should return a standards-aligned insufficient-scope challenge", () => {
    const challenge = buildWwwAuthenticateChallenge(
      "insufficient_scope: missing mail:send",
      "https://api.letterirl.com"
    );
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain("mail:read");
    expect(challenge).toContain("mail:draft");
    expect(challenge).toContain("mail:send");
    expect(challenge).not.toContain("authorization_uri=");
  });
});

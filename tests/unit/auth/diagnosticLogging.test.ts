import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAuthenticatedUser } from "../../../src/auth/identity.js";
import {
  classifyDiagnosticError,
  writeDiagnostic
} from "../../../src/utils/diagnosticLog.js";
import { AuthenticatedUser } from "../../../src/auth/tokenValidator.js";

const sensitiveValues = [
  "auth0|raw-subject-123",
  "private@example.com",
  "lirl_pat_secret-token",
  "123 Private Street",
  "private letter content",
  "https://images.example/private-capability-token"
];

function capturedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join("\n");
}

function productionSources(directory = "src"): string {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? [productionSources(path)]
      : entry.name.endsWith(".ts")
        ? [readFileSync(path, "utf8")]
        : [];
  }).join("\n");
}

describe("privacy-safe authentication diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a useful event and approved error class without arbitrary error content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = Object.assign(new Error(sensitiveValues.join(" ")), {
      code: sensitiveValues[2]
    });

    writeDiagnostic("warn", "auth.jwt_rejected", {
      errorClass: classifyDiagnosticError(error)
    });

    const output = capturedText(warn);
    expect(output).toContain('"event":"auth.jwt_rejected"');
    expect(output).toContain('"errorClass":"unknown_error"');
    for (const sensitive of sensitiveValues) {
      expect(output).not.toContain(sensitive);
    }
  });

  it("preserves known JOSE error classification without logging its message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = Object.assign(new Error(sensitiveValues.join(" ")), {
      code: "ERR_JWT_EXPIRED"
    });

    writeDiagnostic("warn", "auth.jwt_rejected", {
      errorClass: classifyDiagnosticError(error)
    });

    const output = capturedText(warn);
    expect(output).toContain('"errorClass":"ERR_JWT_EXPIRED"');
    expect(output).not.toContain(error.message);
  });

  it("uses the fixed domain taxonomy and known network codes for useful diagnosis", () => {
    const categories = [
      "authorization_error",
      "configuration_error",
      "database_error",
      "provider_error",
      "transport_error",
      "validation_error"
    ] as const;
    for (const category of categories) {
      expect(classifyDiagnosticError(new Error("private"), category)).toBe(category);
    }
    expect(
      classifyDiagnosticError(
        Object.assign(new Error("private"), { code: "ETIMEDOUT" }),
        "configuration_error"
      )
    ).toBe("ETIMEDOUT");
  });

  it("defers account creation without logging the raw subject", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const authInfo: AuthenticatedUser = {
      userId: sensitiveValues[0],
      claims: {},
      token: sensitiveValues[2],
      authType: "pat",
      scopes: []
    };

    await prepareAuthenticatedUser(authInfo, {
      fetchUserInfo: vi.fn(),
      findExistingUser: vi.fn().mockResolvedValue(null),
      upsertUser: vi.fn()
    });

    const output = capturedText(warn);
    expect(output).toContain('"event":"auth.account_creation_deferred"');
    expect(output).toContain('"reason":"verified_email_unavailable"');
    expect(output).not.toContain(authInfo.userId);
    expect(output).not.toContain(authInfo.token);
  });

  it("keeps raw identifiers and arbitrary errors out of OAuth/MCP console calls", () => {
    const sources = [
      "src/auth/identity.ts",
      "src/auth/tokenValidator.ts",
      "src/services/userService.ts",
      "src/services/patService.ts",
      "src/services/returnAddressService.ts",
      "src/services/creditLedgerService.ts",
      "src/services/creditService.ts",
      "src/services/stripeReconciliationService.ts",
      "src/services/providers/PostGridProvider.ts",
      "src/api/patApiHandler.ts",
      "src/api/creditApiHandler.ts",
      "src/api/returnAddressApiHandler.ts",
      "src/api/middleware/restAuth.ts",
      "src/api/middleware/auth.ts",
      "src/api/middleware/adminAuth.ts",
      "src/api/dashboardApiHandler.ts",
      "src/api/adminApiHandler.ts",
      "src/api/middleware/rateLimit.ts",
      "src/store/fileAccountStore.ts",
      "src/server.ts",
      "src/mcp/httpServer.ts",
      "src/mcp/registerTools.ts",
      "src/mcp/stdioServer.ts"
    ].map((path) => readFileSync(path, "utf8")).join("\n");

    expect(sources).not.toMatch(/console\.(?:log|warn|error)[^\n]*(?:userId|authInfo|sessionId|staticClientId)/);
    expect(sources).not.toMatch(/console\.(?:log|warn|error)[^\n]*(?:address\.line1|address\.city|address\.state|postalCode|correctionDetails)/);
    expect(sources).not.toContain('console.error("MCP request failed", error)');
    expect(sources).not.toContain('console.warn("Optional auth validation failed", error)');
    expect(sources).not.toContain('console.error("SSE transport error", error)');
    expect(sources).not.toContain("Error stack:");
    expect(sources).not.toContain("diagnostic: payload");
    expect(sources).not.toContain("userHash");
  });

  it("audits production console calls for indirect sensitive values", () => {
    const sources = productionSources();
    const calls = sources.match(/(?:console|logger)\.(?:log|warn|error|info)\([^;]*\)/g) ?? [];
    const output = calls.join("\n");

    expect(output).not.toMatch(/\$\{[^}]*(?:recipientName|senderName|userId|email|postalCode|clientIp)/);
    expect(output).not.toMatch(/\$\{[^}]*\.(?:id|ledger_id|transaction_id|message|stack)\}/);
    expect(output).not.toMatch(/,\s*(?:error|err|exception|responseBody|requestBody)\s*\)/);
    expect(output).not.toMatch(/(?:tokenResponse|providerResponse|response)\.(?:text|json)\(/);
  });
});

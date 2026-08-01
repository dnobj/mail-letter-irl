import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createCheckoutSession, authenticateHttpRequest, query } = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  authenticateHttpRequest: vi.fn(),
  query: vi.fn()
}));
vi.mock("../../../src/db/index.js", () => ({ query }));
vi.mock("../../../src/api/middleware/auth.js", () => ({
  authenticateHttpRequest
}));
vi.mock("../../../src/services/stripeService.js", () => ({
  createCheckoutSession,
  verifyWebhookSignature: vi.fn(),
  extractCheckoutData: vi.fn(),
  getStripeClient: vi.fn()
}));

import {
  handleAuthCallback,
  handleCreateCheckoutSession
} from "../../../src/api/dashboardApiHandler.js";

describe("dashboard runtime logging privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateHttpRequest.mockResolvedValue({
      userId: "auth0|private-user",
      email: "private@example.com",
      claims: {}
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not log or return a token-exchange response body", async () => {
    const sensitive = "access_token=private-token auth0|private-user";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sensitive, { status: 401 })));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = {
      url: "/auth/callback?code=private-code&state=expected",
      headers: { host: "localhost", cookie: "auth_state=expected" }
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleAuthCallback(req as never, res as never);

    const logged = error.mock.calls.flat().map(String).join("\n");
    const body = String(res.end.mock.calls[0][0]);
    expect(logged).toContain('"event":"auth.token_exchange_failed"');
    expect(logged).toContain('"status":401');
    expect(logged).not.toContain(sensitive);
    expect(body).not.toContain(sensitive);
  });

  it("does not log or return arbitrary checkout exceptions", async () => {
    const sensitive = "private checkout exception cs_private auth0|private-user";
    createCheckoutSession.mockRejectedValue(new Error(sensitive));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = {
      headers: {},
      body: { productId: "credit-pack-4", successUrl: "https://example.test/ok", cancelUrl: "https://example.test/no" }
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleCreateCheckoutSession(req as never, res as never);

    const logged = error.mock.calls.flat().map(String).join("\n");
    const body = String(res.end.mock.calls[0][0]);
    expect(logged).toContain('"event":"credits.checkout_creation_failed"');
    expect(logged).not.toContain(sensitive);
    expect(body).toContain("Unable to create checkout session");
    expect(body).not.toContain(sensitive);
  });

  it("classifies known checkout configuration failures", async () => {
    createCheckoutSession.mockResolvedValue({ success: false, error: "STRIPE_SECRET_KEY not configured" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = {
      headers: {},
      body: { productId: "credit-pack-4", successUrl: "https://example.test/ok", cancelUrl: "https://example.test/no" }
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleCreateCheckoutSession(req as never, res as never);

    expect(error.mock.calls.flat().map(String).join("\n")).toContain('"errorClass":"configuration_error"');
    expect(res.statusCode).toBe(503);
  });

  it("classifies the actual user-email lookup failure as database error", async () => {
    const sensitive = "private database detail auth0|private-user";
    authenticateHttpRequest.mockResolvedValue({ userId: "auth0|private-user", claims: {} });
    query.mockRejectedValue(new Error(sensitive));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = {
      headers: {},
      body: { productId: "credit-pack-4", successUrl: "https://example.test/ok", cancelUrl: "https://example.test/no" }
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleCreateCheckoutSession(req as never, res as never);

    const logged = error.mock.calls.flat().map(String).join("\n");
    const body = String(res.end.mock.calls[0][0]);
    expect(logged).toContain('"errorClass":"database_error"');
    expect(logged).not.toContain(sensitive);
    expect(body).not.toContain(sensitive);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
});

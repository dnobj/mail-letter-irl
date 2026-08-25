import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createPackCheckout,
  processStripeWebhookEvent,
  verifyWebhookSignature,
  authenticateHttpRequest,
  query
} = vi.hoisted(() => ({
  createPackCheckout: vi.fn(),
  processStripeWebhookEvent: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  authenticateHttpRequest: vi.fn(),
  query: vi.fn()
}));
vi.mock("../../../src/db/index.js", () => ({ query }));
vi.mock("../../../src/api/middleware/auth.js", () => ({
  authenticateHttpRequest
}));
vi.mock("../../../src/services/stripeService.js", () => ({
  verifyWebhookSignature
}));
vi.mock("../../../src/services/commerceService.js", () => ({
  createPackCheckout,
  processStripeWebhookEvent
}));

import {
  handleAuthCallback,
  handleCreateCheckoutSession,
  handleStripeWebhook
} from "../../../src/api/dashboardApiHandler.js";

describe("dashboard runtime logging privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateHttpRequest.mockResolvedValue({
      userId: "auth0|private-user",
      email: "private@example.com",
      claims: {}
    });
    createPackCheckout.mockResolvedValue({
      success: true,
      orderId: "private-order",
      sessionId: "private-session",
      sessionUrl: "https://example.test/checkout"
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
    createPackCheckout.mockRejectedValue(new Error(sensitive));
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

  it("logs the real failure class a thrown checkout carries, not a database default", async () => {
    // Issue #213: createPackCheckout attaches the resolved provider class to the
    // error it throws. The handler must log THAT, so a Stripe misconfiguration
    // does not masquerade as a database error - the exact mislabel that made the
    // 500 undiagnosable. The neighbouring test proves a genuine database error
    // (the user-email lookup) still classifies as database_error, so the two
    // paths are now distinct rather than collapsed.
    createPackCheckout.mockRejectedValue(
      Object.assign(new Error("No such price"), { diagnosticClass: "resource_missing" })
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = {
      headers: {},
      body: { productId: "credit-pack-4", successUrl: "https://example.test/ok", cancelUrl: "https://example.test/no" }
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleCreateCheckoutSession(req as never, res as never);

    const logged = error.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain('"errorClass":"resource_missing"');
    expect(logged).not.toContain("database_error");
  });

  it("answers 503 for an unpriced product, whether the fault is terminal or a blip", async () => {
    // createPackCheckout either succeeds or THROWS - its result's `success` is
    // the literal `true`. The previous version of this test mocked a
    // { success: false } return the real function cannot produce, which is how
    // the handler's dead else-branch stayed green while an unpriced pack
    // actually fell through to a bare 500 (#278 review round 4).
    for (const diagnosticClass of ["configuration_error", "StripeConnectionError"]) {
      createPackCheckout.mockRejectedValue(
        Object.assign(new Error("Amount not configured for product: credit-pack-4"), {
          code: "PACK_AMOUNT_NOT_CONFIGURED",
          diagnosticClass,
          terminal: diagnosticClass === "configuration_error"
        })
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const req = {
        headers: {},
        body: { productId: "credit-pack-4", successUrl: "https://example.test/ok", cancelUrl: "https://example.test/no" }
      };
      const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

      await handleCreateCheckoutSession(req as never, res as never);

      expect(error.mock.calls.flat().map(String).join("\n")).toContain(
        `"errorClass":"${diagnosticClass}"`
      );
      expect(res.statusCode, diagnosticClass).toBe(503);
      error.mockRestore();
    }
  });

  it("maps a carried-only terminal class to 503, like the config fault it is", async () => {
    // The session-create rethrow carries diagnosticClass but not always a
    // code. Matching only the literal 'configuration_error' sent
    // amount_too_small / resource_missing / StripeAuthenticationError - the
    // same fault family, already cancelled as terminal - to a bare 500 while
    // the sibling guard one layer earlier answered 503 (#278 review round 5).
    createPackCheckout.mockRejectedValue(
      Object.assign(new Error("amount below Stripe's currency minimum"), {
        diagnosticClass: "amount_too_small"
      })
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = {
      headers: {},
      body: { productId: "credit-pack-4", successUrl: "https://example.test/ok", cancelUrl: "https://example.test/no" }
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleCreateCheckoutSession(req as never, res as never);

    expect(res.statusCode).toBe(503);
    error.mockRestore();
  });

  it("answers 400 for an unknown product id, off the carried validation class", async () => {
    createPackCheckout.mockRejectedValue(
      Object.assign(new Error("Invalid product ID: credit-pack-999"), {
        diagnosticClass: "validation_error"
      })
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const req = {
      headers: {},
      body: { productId: "credit-pack-999", successUrl: "https://example.test/ok", cancelUrl: "https://example.test/no" }
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleCreateCheckoutSession(req as never, res as never);

    expect(res.statusCode).toBe(400);
    error.mockRestore();
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
    expect(createPackCheckout).not.toHaveBeenCalled();
  });

  it("does not log arbitrary commerce webhook exceptions or event identifiers", async () => {
    const sensitive = "private webhook failure evt_private pi_private auth0|private-user";
    verifyWebhookSignature.mockReturnValue({
      id: "evt_private",
      type: "checkout.session.completed",
      data: { object: { id: "cs_private" } }
    });
    processStripeWebhookEvent.mockRejectedValue(new Error(sensitive));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const req = {
      headers: { "stripe-signature": "private-signature" },
      body: "private-body"
    };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };

    await handleStripeWebhook(req as never, res as never);

    const output = [...error.mock.calls, ...log.mock.calls].flat().map(String).join("\n");
    const body = String(res.end.mock.calls[0][0]);
    expect(output).toContain('"event":"credits.webhook_failed"');
    for (const value of [sensitive, "evt_private", "pi_private", "cs_private"]) {
      expect(output).not.toContain(value);
      expect(body).not.toContain(value);
    }
  });
});

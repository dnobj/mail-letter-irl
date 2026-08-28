import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The /healthz build stamp exists so a deploy can be verified from outside.
 *
 * A status code alone cannot distinguish a new build from an old one still
 * serving after a failed deploy — that ambiguity caused a real incident, where a
 * pre-deploy migration failure left the previous image running and every external
 * check still read as healthy.
 *
 * These tests pin the env wiring. The header itself is asserted end-to-end against
 * the deployed service by the remote browser-test agent's healthz spec, which is
 * the correct layer for "the running build is exactly X".
 */
describe("healthz build stamp", () => {
  const OWNED_KEYS = [
    "RAILWAY_GIT_COMMIT_SHA",
    "RAILWAY_GIT_BRANCH",
    "LETTER_IRL_REQUIRE_AUTH",
    "DATABASE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ] as const;

  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(OWNED_KEYS.map((key) => [key, process.env[key]]));

    // Mirrors the boot-validation suite: these are read into module constants at
    // import time, so they must be set before the dynamic import below.
    process.env.LETTER_IRL_REQUIRE_AUTH = "false";
    process.env.DATABASE_URL = "postgres://localhost/letterirl_test";
    process.env.STRIPE_SECRET_KEY = "sk_test_build_stamp_fixture";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_build_stamp_fixture";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  async function loadBuildIdentity() {
    vi.resetModules();
    const module = await import("../../../src/mcp/httpServer.js");
    return { commit: module.BUILD_COMMIT, branch: module.BUILD_BRANCH };
  }

  it("reports the platform-injected commit and branch", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "49dfa50b571628d3ca3a8411ec1056d76920994b";
    process.env.RAILWAY_GIT_BRANCH = "dev";

    const { commit, branch } = await loadBuildIdentity();

    expect(commit).toBe("49dfa50b571628d3ca3a8411ec1056d76920994b");
    expect(branch).toBe("dev");
  });

  it("reports unknown rather than fabricating a value when the platform vars are absent", async () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    delete process.env.RAILWAY_GIT_BRANCH;

    const { commit, branch } = await loadBuildIdentity();

    // "unknown" is deliberate. A fabricated or empty value would make a deploy
    // check pass against a build it never actually verified.
    expect(commit).toBe("unknown");
    expect(branch).toBe("unknown");
  });

  it("does not fall back to unknown when only one of the two is present", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "c03259b208aa11e5f0e21b4c9dbb2e5a2f0d1a77";
    delete process.env.RAILWAY_GIT_BRANCH;

    const { commit, branch } = await loadBuildIdentity();

    expect(commit).toBe("c03259b208aa11e5f0e21b4c9dbb2e5a2f0d1a77");
    expect(branch).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";

import { DEFAULT_TAILSCALE_MTU, tailscaledEnvironment } from "../../../src/admin/tailscale/cli.js";

describe("tailscaled environment", () => {
  it("lowers the tunnel MTU below the path's measured cutoff by default", () => {
    // The direct path to Railway drops tunnel packets from about 1260 bytes,
    // under Tailscale's 1280 default; a full-size TLS handshake segment never
    // arrived and Chrome timed out on every page while curl worked.
    expect(DEFAULT_TAILSCALE_MTU).toBeLessThan(1248);
    const env = tailscaledEnvironment({ PATH: "/usr/bin" });
    expect(env.TS_DEBUG_MTU).toBe(String(DEFAULT_TAILSCALE_MTU));
    expect(env.PATH).toBe("/usr/bin");
  });

  it("lets a service variable override the default", () => {
    expect(tailscaledEnvironment({ TS_DEBUG_MTU: "1150" }).TS_DEBUG_MTU).toBe("1150");
  });
});

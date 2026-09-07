import { describe, expect, it } from "vitest";

import { parseWhois } from "../../../src/admin/tailscale/cli.js";
import {
  TailscaleSupervisor,
  assertNodeIdentity,
  refuseIfPublicDomain,
  summarizeStatus,
  type DaemonHandle,
  type TailscaleCli,
  type TailscaleCliResult,
} from "../../../src/admin/tailscale/daemon.js";

const AUTH_KEY = "tskey-auth-kTESTKEY-secretsecret";

function statusJson(
  backendState: string,
  self: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    BackendState: backendState,
    Self: {
      DNSName: "letter-irl-admin-dev.tail1234.ts.net.",
      HostName: "letter-irl-admin-dev",
      Tags: ["tag:dev-admin"],
      TailscaleIPs: ["100.64.0.9", "fd7a:115c:a1e0::9"],
      Online: backendState === "Running",
      ...self,
    },
    CurrentTailnet: { MagicDNSSuffix: "tail1234.ts.net" },
  });
}

/** A scripted CLI: each `status --json` call consumes the next state. */
function scriptedCli(
  states: string[],
  overrides: Partial<Record<string, (args: string[]) => TailscaleCliResult>> = {},
) {
  const calls: string[][] = [];
  let statusIndex = 0;
  const cli: TailscaleCli = {
    async run(args) {
      calls.push(args);
      const command = args[0];
      if (command === "status") {
        const state = states[Math.min(statusIndex, states.length - 1)];
        statusIndex += 1;
        if (state === "silent") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: state, stderr: "" };
      }
      const override = overrides[command];
      if (override) return override(args);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { cli, calls };
}

function fakeDaemon() {
  const listeners: Array<(code: number | null, signal: string | null) => void> =
    [];
  let killed: string | null = null;
  const handle: DaemonHandle = {
    pid: 4242,
    onExit(listener) {
      listeners.push(listener);
    },
    kill(signal = "SIGTERM") {
      killed = signal;
    },
  };
  return {
    handle,
    exit(code: number | null, signal: string | null = null) {
      for (const listener of listeners) listener(code, signal);
    },
    get killed() {
      return killed;
    },
  };
}

function supervisor(
  cli: TailscaleCli,
  daemon: DaemonHandle,
  options: { authKey?: string; log?: string[]; readyTimeoutMs?: number } = {},
) {
  const log = options.log ?? [];
  return new TailscaleSupervisor({
    hostname: "letter-irl-admin-dev",
    tag: "tag:dev-admin",
    stateFile: "/data/tailscale/tailscaled.state",
    socketPath: "/data/tailscale/tailscaled.sock",
    appPort: 8790,
    authKey: options.authKey,
    spawnDaemon: () => daemon,
    cli,
    sleep: async () => {},
    log: (line) => log.push(line),
    readyTimeoutMs: options.readyTimeoutMs ?? 5_000,
    pollIntervalMs: 1,
  });
}

describe("Tailscale supervisor", () => {
  it("brings a NeedsLogin node up with the one-off key, serves loopback, and verifies the identity", async () => {
    const { cli, calls } = scriptedCli([
      "silent",
      statusJson("NeedsLogin", { Tags: [], DNSName: "" }),
      statusJson("Starting"),
      statusJson("Running"),
      statusJson("Running"),
    ]);
    const daemon = fakeDaemon();
    const log: string[] = [];
    const sut = supervisor(cli, daemon.handle, { authKey: AUTH_KEY, log });

    const identity = await sut.start();

    expect(identity.dnsName).toBe("letter-irl-admin-dev.tail1234.ts.net");
    expect(identity.tags).toEqual(["tag:dev-admin"]);
    expect(sut.isHealthy()).toBe(true);
    const up = calls.find((args) => args[0] === "up");
    expect(up).toEqual([
      "up",
      "--hostname=letter-irl-admin-dev",
      "--advertise-tags=tag:dev-admin",
      "--accept-dns=false",
      "--timeout=90s",
      `--auth-key=${AUTH_KEY}`,
    ]);
    expect(calls).toContainEqual([
      "serve",
      "--bg",
      "--https=443",
      "http://127.0.0.1:8790",
    ]);
    // The key is an argument to the CLI, never a log line.
    expect(log.join("\n")).not.toContain(AUTH_KEY);
    expect(daemon.killed).toBeNull();
  });

  it("refuses a NeedsLogin node when no key is present, and kills the daemon", async () => {
    const { cli, calls } = scriptedCli([statusJson("NeedsLogin", { Tags: [] })]);
    const daemon = fakeDaemon();
    const sut = supervisor(cli, daemon.handle);

    await expect(sut.start()).rejects.toMatchObject({
      code: "ADMIN_TAILSCALE_NEEDS_LOGIN",
    });
    expect(calls.some((args) => args[0] === "up")).toBe(false);
    expect(daemon.killed).toBe("SIGTERM");
    expect(sut.isHealthy()).toBe(false);
  });

  it("re-asserts settings without a key when the node is merely Stopped", async () => {
    const { cli, calls } = scriptedCli([
      statusJson("Stopped"),
      statusJson("Running"),
      statusJson("Running"),
    ]);
    const sut = supervisor(cli, fakeDaemon().handle);
    await sut.start();
    const up = calls.find((args) => args[0] === "up");
    expect(up).toBeDefined();
    expect(up!.some((arg) => arg.startsWith("--auth-key"))).toBe(false);
  });

  it("does not issue up at all when the node is already Running", async () => {
    const { cli, calls } = scriptedCli([statusJson("Running")]);
    const sut = supervisor(cli, fakeDaemon().handle, { authKey: AUTH_KEY });
    await sut.start();
    expect(calls.some((args) => args[0] === "up")).toBe(false);
  });

  it("refuses a node carrying another environment's tag", async () => {
    const { cli } = scriptedCli([
      statusJson("Running", { Tags: ["tag:prod-admin"] }),
    ]);
    const daemon = fakeDaemon();
    await expect(supervisor(cli, daemon.handle).start()).rejects.toMatchObject({
      code: "ADMIN_TAILSCALE_TAG_MISMATCH",
    });
    expect(daemon.killed).toBe("SIGTERM");
  });

  it("refuses a node with two tags or with no tag", async () => {
    expect(() =>
      assertNodeIdentity(
        summarizeStatus(
          JSON.parse(
            statusJson("Running", { Tags: ["tag:dev-admin", "tag:server"] }),
          ),
        ),
        { hostname: "letter-irl-admin-dev", tag: "tag:dev-admin" },
      ),
    ).toThrowError(expect.objectContaining({ code: "ADMIN_TAILSCALE_TAG_MISMATCH" }));
    expect(() =>
      assertNodeIdentity(
        summarizeStatus(JSON.parse(statusJson("Running", { Tags: [] }))),
        { hostname: "letter-irl-admin-dev", tag: "tag:dev-admin" },
      ),
    ).toThrowError(expect.objectContaining({ code: "ADMIN_TAILSCALE_TAG_MISMATCH" }));
  });

  it("refuses a node whose name is not the expected hostname (a -1 suffix included)", async () => {
    const { cli } = scriptedCli([
      statusJson("Running", { DNSName: "letter-irl-admin-dev-1.tail1234.ts.net." }),
    ]);
    await expect(
      supervisor(cli, fakeDaemon().handle).start(),
    ).rejects.toMatchObject({ code: "ADMIN_TAILSCALE_NAME_MISMATCH" });
  });

  it("fails closed when serve cannot be configured", async () => {
    const { cli } = scriptedCli([statusJson("Running")], {
      serve: () => ({ code: 1, stdout: "", stderr: "serve: HTTPS is not enabled" }),
    });
    const daemon = fakeDaemon();
    await expect(supervisor(cli, daemon.handle).start()).rejects.toMatchObject({
      code: "ADMIN_TAILSCALE_UNAVAILABLE",
    });
    expect(daemon.killed).toBe("SIGTERM");
  });

  it("gives up when the daemon never answers before the deadline", async () => {
    const { cli } = scriptedCli(["silent"]);
    await expect(
      supervisor(cli, fakeDaemon().handle, { readyTimeoutMs: 1 }).start(),
    ).rejects.toMatchObject({ code: "ADMIN_TAILSCALE_UNAVAILABLE" });
  });

  it("propagates a daemon exit to its listeners and stops reporting healthy", async () => {
    const { cli } = scriptedCli([statusJson("Running")]);
    const daemon = fakeDaemon();
    const sut = supervisor(cli, daemon.handle);
    await sut.start();
    const exits: Array<[number | null, string | null]> = [];
    sut.onExit((code, signal) => exits.push([code, signal]));

    daemon.exit(2);

    expect(exits).toEqual([[2, null]]);
    expect(sut.state).toBe("exited");
    expect(sut.isHealthy()).toBe(false);
  });

  it("treats an exit during shutdown as a stop, not a failure", async () => {
    const { cli } = scriptedCli([statusJson("Running")]);
    const daemon = fakeDaemon();
    const sut = supervisor(cli, daemon.handle);
    await sut.start();
    const exits: unknown[] = [];
    sut.onExit((code) => exits.push(code));
    await sut.stop();
    daemon.exit(0, "SIGTERM");
    expect(exits).toEqual([]);
    expect(sut.state).toBe("stopped");
  });

  it("refuses to run when Railway reports a public domain", () => {
    expect(() =>
      refuseIfPublicDomain({ RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" }),
    ).toThrowError(expect.objectContaining({ code: "ADMIN_PUBLIC_DOMAIN_PRESENT" }));
    expect(() =>
      refuseIfPublicDomain({ RAILWAY_STATIC_URL: "x.up.railway.app" }),
    ).toThrowError(expect.objectContaining({ code: "ADMIN_PUBLIC_DOMAIN_PRESENT" }));
    expect(() => refuseIfPublicDomain({})).not.toThrow();
  });
});

describe("whois parsing", () => {
  it("returns the login and node name for a user-owned peer", () => {
    expect(
      parseWhois(
        JSON.stringify({
          Node: { Name: "owner-laptop.tail1234.ts.net.", Tags: null },
          UserProfile: { LoginName: "owner@example.com", DisplayName: "Owner" },
        }),
      ),
    ).toEqual({
      login: "owner@example.com",
      displayName: "Owner",
      nodeName: "owner-laptop.tail1234.ts.net",
    });
  });

  it("refuses tagged peers, peers without a login, and malformed output", () => {
    expect(
      parseWhois(
        JSON.stringify({
          Node: { Name: "other-admin.tail1234.ts.net.", Tags: ["tag:prod-admin"] },
          UserProfile: { LoginName: "tagged-devices" },
        }),
      ),
    ).toBeNull();
    expect(
      parseWhois(JSON.stringify({ Node: { Name: "x.ts.net." }, UserProfile: {} })),
    ).toBeNull();
    expect(parseWhois("not json")).toBeNull();
  });
});

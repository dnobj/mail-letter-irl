import { spawn } from "node:child_process";

import type { DaemonHandle, TailscaleCli, TailscaleCliResult } from "./daemon.js";

/**
 * The real process seams behind the supervisor: spawn `tailscaled`, run the
 * `tailscale` CLI against its socket, and ask the daemon who a peer is.
 */

export interface SpawnTailscaledOptions {
  stateFile: string;
  socketPath: string;
  binary?: string;
  log?: (line: string) => void;
}

export function spawnTailscaled(options: SpawnTailscaledOptions): DaemonHandle {
  const log = options.log ?? ((line: string) => console.log(line));
  const child = spawn(
    options.binary ?? "tailscaled",
    [
      "--tun=userspace-networking",
      `--state=${options.stateFile}`,
      `--socket=${options.socketPath}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const forward = (stream: NodeJS.ReadableStream | null, label: string) => {
    if (!stream) return;
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line) log(`[tailscaled ${label}] ${line.slice(0, 500)}`);
        index = buffer.indexOf("\n");
      }
    });
  };
  forward(child.stdout, "out");
  forward(child.stderr, "err");
  return {
    pid: child.pid,
    onExit(listener) {
      child.on("exit", (code, signal) => listener(code, signal));
      child.on("error", () => listener(null, "spawn-error"));
    },
    kill(signal = "SIGTERM") {
      child.kill(signal);
    },
  };
}

export function createTailscaleCli(
  socketPath: string,
  binary = "tailscale",
): TailscaleCli {
  return {
    run(args, options): Promise<TailscaleCliResult> {
      const timeoutMs = options?.timeoutMs ?? 30_000;
      return new Promise((resolve) => {
        const child = spawn(binary, [`--socket=${socketPath}`, ...args], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          resolve({ code: null, stdout, stderr: `${stderr}\ntimeout` });
        }, timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
    },
  };
}

export interface WhoisResult {
  login: string;
  displayName: string | null;
  nodeName: string;
}

export interface WhoisClient {
  /** Resolves null when the peer is not a user-owned node (tagged, or unknown). */
  whois(address: string): Promise<WhoisResult | null>;
}

const ADDRESS_PATTERN = /^[0-9A-Fa-f:.]{3,64}$/;

/**
 * `tailscale whois --json <ip>` returns the peer's node and, for user-owned
 * devices, the user profile the control plane bound at login. Tagged nodes
 * have no login and are refused by returning null.
 */
export function createWhoisClient(cli: TailscaleCli): WhoisClient {
  return {
    async whois(address: string): Promise<WhoisResult | null> {
      if (!ADDRESS_PATTERN.test(address)) return null;
      const result = await cli.run(["whois", "--json", address], {
        timeoutMs: 15_000,
      });
      if (result.code !== 0) return null;
      return parseWhois(result.stdout);
    },
  };
}

export function parseWhois(stdout: string): WhoisResult | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  const node = (record.Node ?? {}) as Record<string, unknown>;
  const profile = (record.UserProfile ?? {}) as Record<string, unknown>;
  const login = typeof profile.LoginName === "string" ? profile.LoginName : "";
  const nodeName = typeof node.Name === "string" ? node.Name : "";
  const tags = Array.isArray(node.Tags) ? node.Tags : [];
  if (!login || !nodeName || tags.length > 0) return null;
  return {
    login,
    displayName:
      typeof profile.DisplayName === "string" && profile.DisplayName
        ? profile.DisplayName
        : null,
    nodeName: nodeName.replace(/\.$/, "").toLowerCase(),
  };
}

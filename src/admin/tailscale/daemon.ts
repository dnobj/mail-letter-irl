import { AdminFoundationError, type AdminErrorCode } from "../errors.js";

/**
 * Supervision of `tailscaled` inside the admin container.
 *
 * The container has no /dev/net/tun and no privileges, so the daemon runs in
 * userspace-networking mode and the only thing it needs from the host is an
 * outbound connection. Node is PID 1: it spawns the daemon, brings the node
 * up, publishes the loopback app listener with Tailscale Serve, verifies the
 * node is exactly the one this environment expects, and exits if the daemon
 * dies so Railway restarts the service.
 *
 * Every external interaction goes through two injectable seams, `spawnDaemon`
 * and `cli`, so the state machine is unit-tested with a scripted CLI and the
 * real binaries are touched only in the container.
 */

export interface TailscaleCliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface TailscaleCli {
  run(
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<TailscaleCliResult>;
}

export interface DaemonHandle {
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
  readonly pid?: number;
}

export interface TailscaleStatusSummary {
  backendState: string;
  dnsName: string | null;
  hostName: string | null;
  tags: string[];
  tailscaleIps: string[];
  online: boolean;
  magicDnsSuffix: string | null;
  authUrlPresent: boolean;
}

export interface TailscaleNodeIdentity {
  /** The node's FQDN without the trailing dot, e.g. letter-irl-admin-dev.tail1234.ts.net */
  dnsName: string;
  hostName: string;
  magicDnsSuffix: string | null;
  tags: string[];
  tailscaleIps: string[];
}

export interface TailscaleSupervisorOptions {
  hostname: string;
  tag: string;
  stateFile: string;
  socketPath: string;
  appPort: number;
  /** TS_AUTHKEY, present on the first boot only. Never logged. */
  authKey?: string;
  spawnDaemon: () => DaemonHandle;
  cli: TailscaleCli;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * How long a NoState report may last before it is read as "no profile to
   * load". tailscaled reports NoState on every boot while it reads the state
   * file from the volume and completes its login, so a node that rejoins after
   * a redeploy passes through it; only a NoState that outlives this window
   * means the node has never been registered.
   */
  noStateGraceMs?: number;
}

export type SupervisorState =
  | "idle"
  | "starting"
  | "running"
  | "exited"
  | "stopped";

const DEFAULT_READY_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_NO_STATE_GRACE_MS = 30_000;

/**
 * The admin service must never have a public domain. Railway sets these when
 * one exists; an operator who generates one by accident must get a boot
 * failure, not a panel on the internet.
 */
export function refuseIfPublicDomain(env: NodeJS.ProcessEnv): void {
  if (env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_STATIC_URL) {
    throw new AdminFoundationError("ADMIN_PUBLIC_DOMAIN_PRESENT");
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Parse the output of `tailscale status --json` into the fields we act on. */
export function summarizeStatus(json: unknown): TailscaleStatusSummary {
  const status = (json ?? {}) as Record<string, unknown>;
  const self = (status.Self ?? {}) as Record<string, unknown>;
  const tailnet = (status.CurrentTailnet ?? {}) as Record<string, unknown>;
  return {
    backendState: asString(status.BackendState) ?? "NoState",
    dnsName: asString(self.DNSName),
    hostName: asString(self.HostName),
    tags: asStringArray(self.Tags),
    tailscaleIps: asStringArray(self.TailscaleIPs),
    online: self.Online === true,
    magicDnsSuffix: asString(tailnet.MagicDNSSuffix),
    authUrlPresent: typeof status.AuthURL === "string" && status.AuthURL !== "",
  };
}

/**
 * The node must carry exactly this environment's tag and the expected name.
 * A development panel that somehow joined with the production tag, or the
 * other way round, is refused before the application listens.
 */
export function assertNodeIdentity(
  summary: TailscaleStatusSummary,
  expected: { hostname: string; tag: string },
): TailscaleNodeIdentity {
  const tags = summary.tags.map((tag) => tag.toLowerCase());
  if (tags.length !== 1 || tags[0] !== expected.tag.toLowerCase()) {
    throw new AdminFoundationError("ADMIN_TAILSCALE_TAG_MISMATCH");
  }
  const dnsName = (summary.dnsName ?? "").toLowerCase().replace(/\.$/, "");
  const firstLabel = dnsName.split(".")[0];
  if (!dnsName || firstLabel !== expected.hostname.toLowerCase()) {
    throw new AdminFoundationError("ADMIN_TAILSCALE_NAME_MISMATCH");
  }
  return {
    dnsName,
    hostName: summary.hostName ?? expected.hostname,
    magicDnsSuffix: summary.magicDnsSuffix,
    tags: summary.tags,
    tailscaleIps: summary.tailscaleIps,
  };
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A one-line, value-free description of a CLI failure for the deploy log. */
function describeFailure(result: TailscaleCliResult): string {
  const stderr = result.stderr.trim().split("\n").at(-1) ?? "";
  // The auth key never appears in stderr, but an operator could paste a URL
  // or a hostname into the console; keep the line short and free of anything
  // that looks like a key.
  const scrubbed = stderr.replace(/tskey-[A-Za-z0-9-]+/g, "tskey-[redacted]");
  return `exit=${result.code ?? "signal"} ${scrubbed.slice(0, 200)}`;
}

export class TailscaleSupervisor {
  private readonly options: Required<
    Pick<
      TailscaleSupervisorOptions,
      "sleep" | "log" | "readyTimeoutMs" | "pollIntervalMs" | "noStateGraceMs"
    >
  > &
    TailscaleSupervisorOptions;
  private daemon: DaemonHandle | null = null;
  private stateValue: SupervisorState = "idle";
  private identityValue: TailscaleNodeIdentity | null = null;
  private stopping = false;
  private readonly exitListeners: Array<
    (code: number | null, signal: string | null) => void
  > = [];

  constructor(options: TailscaleSupervisorOptions) {
    this.options = {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
      readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      ...options,
      noStateGraceMs: options.noStateGraceMs ?? DEFAULT_NO_STATE_GRACE_MS,
    };
  }

  get state(): SupervisorState {
    return this.stateValue;
  }

  get identity(): TailscaleNodeIdentity | null {
    return this.identityValue;
  }

  isHealthy(): boolean {
    return this.stateValue === "running";
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  private log(line: string): void {
    this.options.log(`[tailscale] ${line}`);
  }

  private async cli(
    args: string[],
    timeoutMs?: number,
  ): Promise<TailscaleCliResult> {
    return this.options.cli.run(args, timeoutMs ? { timeoutMs } : undefined);
  }

  private async readStatus(): Promise<TailscaleStatusSummary | null> {
    const result = await this.cli(["status", "--json"], 15_000);
    const json = parseJson(result.stdout);
    if (!json || typeof json !== "object") {
      return null;
    }
    return summarizeStatus(json);
  }

  private async fail(code: AdminErrorCode): Promise<never> {
    await this.stop();
    throw new AdminFoundationError(code);
  }

  /**
   * Bring the node up and publish the app listener. Resolves with the verified
   * identity; rejects with a stable code after killing the daemon.
   */
  async start(): Promise<TailscaleNodeIdentity> {
    if (this.stateValue !== "idle") {
      throw new AdminFoundationError("ADMIN_INTERNAL_ERROR");
    }
    this.stateValue = "starting";
    const daemon = this.options.spawnDaemon();
    this.daemon = daemon;
    daemon.onExit((code, signal) => {
      if (this.stopping) {
        this.stateValue = "stopped";
        return;
      }
      this.stateValue = "exited";
      this.log(`daemon exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      for (const listener of this.exitListeners) {
        listener(code, signal);
      }
    });
    this.log(`daemon spawned pid=${daemon.pid ?? "unknown"}`);

    const deadline = Date.now() + this.options.readyTimeoutMs;
    const noStateDeadline = Date.now() + this.options.noStateGraceMs;
    let summary: TailscaleStatusSummary | null = null;
    let upIssued = false;
    let lastLogged = "";

    while (Date.now() < deadline) {
      if ((this.stateValue as SupervisorState) === "exited") {
        throw new AdminFoundationError("ADMIN_TAILSCALE_DAEMON_EXITED");
      }
      summary = await this.readStatus();
      if (!summary) {
        await this.options.sleep(this.options.pollIntervalMs);
        continue;
      }
      const stateLine = `backend=${summary.backendState} tags=${summary.tags.join(",") || "-"} name=${summary.dnsName ?? "-"}`;
      if (stateLine !== lastLogged) {
        this.log(stateLine);
        lastLogged = stateLine;
      }

      if (summary.backendState === "Running") {
        break;
      }
      if (summary.backendState === "NeedsMachineAuth") {
        // Device approval or Tailnet Lock signing pending: wait for the owner.
        await this.options.sleep(this.options.pollIntervalMs);
        continue;
      }
      if (
        summary.backendState === "NoState" &&
        !upIssued &&
        Date.now() < noStateDeadline
      ) {
        // Transitional: the daemon is still loading the persisted profile and
        // logging in. Deciding "needs a key" here is what made a redeploy fail
        // with ADMIN_TAILSCALE_NEEDS_LOGIN while the volume held a valid node.
        await this.options.sleep(this.options.pollIntervalMs);
        continue;
      }
      if (
        summary.backendState === "NeedsLogin" ||
        summary.backendState === "NoState" ||
        summary.backendState === "Stopped"
      ) {
        if (upIssued) {
          await this.options.sleep(this.options.pollIntervalMs);
          continue;
        }
        const needsKey = summary.backendState !== "Stopped";
        if (needsKey && !this.options.authKey) {
          return this.fail("ADMIN_TAILSCALE_NEEDS_LOGIN");
        }
        const args = [
          "up",
          `--hostname=${this.options.hostname}`,
          `--advertise-tags=${this.options.tag}`,
          "--accept-dns=false",
          "--timeout=90s",
        ];
        if (needsKey && this.options.authKey) {
          args.push(`--auth-key=${this.options.authKey}`);
        }
        this.log(`issuing up (key ${needsKey ? "present" : "not needed"})`);
        const result = await this.cli(args, 120_000);
        upIssued = true;
        if (result.code !== 0) {
          this.log(`up failed: ${describeFailure(result)}`);
          return this.fail("ADMIN_TAILSCALE_UNAVAILABLE");
        }
        continue;
      }
      // Starting, or an unknown state: keep polling.
      await this.options.sleep(this.options.pollIntervalMs);
    }

    if (!summary || summary.backendState !== "Running") {
      this.log("node did not reach Running before the deadline");
      return this.fail("ADMIN_TAILSCALE_UNAVAILABLE");
    }

    // Publish the loopback listener to the tailnet. Persisted in state, so a
    // restart resumes it; re-issuing the same command is idempotent.
    const serve = await this.cli(
      [
        "serve",
        "--bg",
        "--https=443",
        `http://127.0.0.1:${this.options.appPort}`,
      ],
      60_000,
    );
    if (serve.code !== 0) {
      this.log(`serve failed: ${describeFailure(serve)}`);
      return this.fail("ADMIN_TAILSCALE_UNAVAILABLE");
    }

    const finalSummary = (await this.readStatus()) ?? summary;
    let identity: TailscaleNodeIdentity;
    try {
      identity = assertNodeIdentity(finalSummary, {
        hostname: this.options.hostname,
        tag: this.options.tag,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.identityValue = identity;
    this.stateValue = "running";
    this.log(
      `ready name=${identity.dnsName} tags=${identity.tags.join(",")} ips=${identity.tailscaleIps.length}`,
    );
    return identity;
  }

  /** `tailscale serve status`, for the deploy log while unhealthy. */
  async serveStatus(): Promise<string> {
    const result = await this.cli(["serve", "status"], 15_000);
    return (result.stdout || result.stderr).trim().slice(0, 2000);
  }

  /** Re-read the backend state; used by the health listener. */
  async isRunning(): Promise<boolean> {
    if (this.stateValue !== "running") return false;
    const summary = await this.readStatus();
    return summary?.backendState === "Running";
  }

  async stop(): Promise<void> {
    if (!this.daemon) {
      this.stateValue = "stopped";
      return;
    }
    this.stopping = true;
    try {
      this.daemon.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    this.stateValue = "stopped";
  }
}
